/*
 * landlock-write-sandbox — confine an edit-run CLI's durable writes.
 *
 * Hermes Studio lets a model edit code unattended on a schedule. `cwd` and
 * `--in` are conveniences, not boundaries: an absolute path in a prompt or a
 * confused model can still write anywhere the user can. This launcher applies
 * a Linux Landlock ruleset that denies every write/namespace-mutation right
 * except beneath the directories we explicitly allow, then execs the real CLI
 * in the same PID.
 *
 * Reads are deliberately NOT handled: the model must still read the repo,
 * its own credentials, and shared libraries. Only durable writes are confined.
 *
 * Fails closed. Any parse, open, ABI or syscall failure exits 125 BEFORE the
 * target program is executed, so a broken sandbox can never silently degrade
 * into an unconfined run.
 *
 * usage: landlock-write-sandbox --allow DIR [--allow DIR ...] -- PROGRAM [ARG ...]
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/landlock.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef SYS_landlock_create_ruleset
#error "Landlock syscall numbers are unavailable in the system headers"
#endif
#ifndef LANDLOCK_ACCESS_FS_TRUNCATE
#error "Landlock ABI v3 headers are required"
#endif
#ifndef LANDLOCK_ACCESS_FS_IOCTL_DEV
#define LANDLOCK_ACCESS_FS_IOCTL_DEV (1ULL << 15)
#endif

#define SETUP_FAILURE 125

static void usage(const char *name) {
    fprintf(stderr, "usage: %s --allow DIR [--allow DIR ...] -- PROGRAM [ARG ...]\n", name);
    exit(SETUP_FAILURE);
}

static void fail(const char *operation) {
    fprintf(stderr, "landlock-write-sandbox: %s: %s\n", operation, strerror(errno));
    exit(SETUP_FAILURE);
}

static int create_ruleset(const struct landlock_ruleset_attr *attr,
                          size_t size, uint32_t flags) {
    return (int)syscall(SYS_landlock_create_ruleset, attr, size, flags);
}

static int add_path_rule(int ruleset_fd,
                         const struct landlock_path_beneath_attr *attr) {
    return (int)syscall(SYS_landlock_add_rule, ruleset_fd,
                        LANDLOCK_RULE_PATH_BENEATH, attr, 0);
}

static int restrict_self(int ruleset_fd) {
    return (int)syscall(SYS_landlock_restrict_self, ruleset_fd, 0);
}

int main(int argc, char **argv) {
    size_t allow_count = 0;
    int pos = 1;

    while (pos < argc && strcmp(argv[pos], "--") != 0) {
        if (strcmp(argv[pos], "--allow") != 0 || pos + 1 >= argc)
            usage(argv[0]);
        ++allow_count;
        pos += 2;
    }
    if (allow_count == 0 || pos >= argc || strcmp(argv[pos], "--") != 0 || pos + 1 >= argc)
        usage(argv[0]);
    const int command_pos = pos + 1;

    /* The syscall is authoritative. Do NOT probe /sys/kernel/security/landlock:
     * this WSL2 host reports ABI 3 while that sysfs entry does not exist. */
    int abi = create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
    if (abi < 0)
        fail("querying the Landlock ABI");
    /* ABI 2 cannot mediate truncate(2), which would let a model empty any file. */
    if (abi < 3) {
        fprintf(stderr,
                "landlock-write-sandbox: Landlock ABI 3 or newer is required (kernel reports ABI %d)\n",
                abi);
        return SETUP_FAILURE;
    }

    uint64_t write_access =
        LANDLOCK_ACCESS_FS_WRITE_FILE |
        LANDLOCK_ACCESS_FS_REMOVE_DIR |
        LANDLOCK_ACCESS_FS_REMOVE_FILE |
        LANDLOCK_ACCESS_FS_MAKE_CHAR |
        LANDLOCK_ACCESS_FS_MAKE_DIR |
        LANDLOCK_ACCESS_FS_MAKE_REG |
        LANDLOCK_ACCESS_FS_MAKE_SOCK |
        LANDLOCK_ACCESS_FS_MAKE_FIFO |
        LANDLOCK_ACCESS_FS_MAKE_BLOCK |
        LANDLOCK_ACCESS_FS_MAKE_SYM |
        LANDLOCK_ACCESS_FS_REFER |
        LANDLOCK_ACCESS_FS_TRUNCATE;
    if (abi >= 5)
        write_access |= LANDLOCK_ACCESS_FS_IOCTL_DEV;

    struct landlock_ruleset_attr ruleset_attr = {
        .handled_access_fs = write_access,
    };
    int ruleset_fd = create_ruleset(&ruleset_attr, sizeof(ruleset_attr), 0);
    if (ruleset_fd < 0)
        fail("creating the Landlock ruleset");

    pos = 1;
    while (pos < command_pos - 1) {
        const char *path = argv[pos + 1];
        if (path[0] != '/') {
            fprintf(stderr, "landlock-write-sandbox: allowed path must be absolute: %s\n", path);
            return SETUP_FAILURE;
        }
        int path_fd = open(path, O_PATH | O_DIRECTORY | O_CLOEXEC);
        if (path_fd < 0)
            fail(path);

        struct stat st;
        if (fstat(path_fd, &st) < 0)
            fail("checking an allowed path");
        if (!S_ISDIR(st.st_mode)) {
            fprintf(stderr, "landlock-write-sandbox: allowed path is not a directory: %s\n", path);
            return SETUP_FAILURE;
        }

        struct landlock_path_beneath_attr path_rule = {
            .allowed_access = write_access,
            .parent_fd = path_fd,
        };
        if (add_path_rule(ruleset_fd, &path_rule) < 0)
            fail("adding an allowed path to the Landlock ruleset");
        if (close(path_fd) < 0)
            fail("closing an allowed-path descriptor");
        pos += 2;
    }

    /* /dev/null is non-durable and CLIs redirect to it constantly. */
    int null_fd = open("/dev/null", O_PATH | O_CLOEXEC);
    if (null_fd < 0)
        fail("opening /dev/null");
    struct landlock_path_beneath_attr null_rule = {
        .allowed_access = LANDLOCK_ACCESS_FS_WRITE_FILE,
        .parent_fd = null_fd,
    };
    if (add_path_rule(ruleset_fd, &null_rule) < 0)
        fail("allowing writes to /dev/null");
    if (close(null_fd) < 0)
        fail("closing the /dev/null descriptor");

    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0)
        fail("setting no_new_privs");
    if (restrict_self(ruleset_fd) < 0)
        fail("enforcing the Landlock ruleset");
    if (close(ruleset_fd) < 0)
        fail("closing the Landlock ruleset descriptor");

    /* execvp keeps the same PID, so the caller's process-group kill still works. */
    execvp(argv[command_pos], &argv[command_pos]);
    fprintf(stderr, "landlock-write-sandbox: exec %s: %s\n",
            argv[command_pos], strerror(errno));
    return errno == ENOENT ? 127 : 126;
}
