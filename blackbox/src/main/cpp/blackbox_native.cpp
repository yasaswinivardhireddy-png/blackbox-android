// Native crash handler for Blackbox.
//
// Everything reachable from HandleSignal must be async-signal-safe: no malloc, no locks, no
// stdio, no C++ runtime. The report is a small line-oriented text file written with write(2);
// the Kotlin side converts it to JSON on the next launch.
//
// After writing, the previous handler (Android's debuggerd) is restored and the signal is
// re-delivered, so the platform still produces its tombstone and the process dies as usual.

#ifndef _GNU_SOURCE
#define _GNU_SOURCE 1
#endif

#include <dlfcn.h>
#include <elf.h>
#include <errno.h>
#include <fcntl.h>
#include <jni.h>
#include <link.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <time.h>
#include <ucontext.h>
#include <unistd.h>
#include <unwind.h>

#ifndef NT_GNU_BUILD_ID
#define NT_GNU_BUILD_ID 3
#endif

namespace {

constexpr int kSignals[] = {SIGSEGV, SIGBUS, SIGFPE, SIGILL, SIGABRT, SIGTRAP, SIGSYS};
constexpr int kSignalCount = sizeof(kSignals) / sizeof(kSignals[0]);
constexpr int kMaxFrames = 64;
constexpr int kCrumbSlots = 32;
constexpr int kCrumbLength = 160;

struct sigaction g_previous[kSignalCount];
char g_report_path[512];
char g_session_id[80];
int g_installed = 0;
int g_handling = 0;

char g_crumbs[kCrumbSlots][kCrumbLength];
unsigned g_crumb_next = 0;

int SignalIndex(int sig) {
  for (int i = 0; i < kSignalCount; i++) {
    if (kSignals[i] == sig) return i;
  }
  return -1;
}

const char* SignalName(int sig) {
  switch (sig) {
    case SIGSEGV: return "SIGSEGV";
    case SIGBUS: return "SIGBUS";
    case SIGFPE: return "SIGFPE";
    case SIGILL: return "SIGILL";
    case SIGABRT: return "SIGABRT";
    case SIGTRAP: return "SIGTRAP";
    case SIGSYS: return "SIGSYS";
    default: return "UNKNOWN";
  }
}

// Buffered writer built only on write(2).
class Writer {
 public:
  explicit Writer(int fd) : fd_(fd) {}
  ~Writer() { Flush(); }

  void Char(char c) {
    if (len_ == sizeof(buf_)) Flush();
    buf_[len_++] = c;
  }

  void Str(const char* s) {
    while (*s) Char(*s++);
  }

  // Single-line, space-free token: separators would corrupt the line format.
  void Token(const char* s, size_t max = 256) {
    size_t n = 0;
    if (*s == '\0') Char('?');
    for (; *s && n < max; s++, n++) Char(*s == ' ' || *s == '\n' || *s == '\r' ? '_' : *s);
  }

  // Free text to end of line.
  void Line(const char* s, size_t max = 256) {
    for (size_t n = 0; *s && n < max; s++, n++) Char(*s == '\n' || *s == '\r' ? ' ' : *s);
  }

  void Dec(int64_t value) {
    char tmp[24];
    int i = 0;
    uint64_t v = value < 0 ? static_cast<uint64_t>(-(value + 1)) + 1 : static_cast<uint64_t>(value);
    do {
      tmp[i++] = static_cast<char>('0' + v % 10);
      v /= 10;
    } while (v != 0);
    if (value < 0) Char('-');
    while (i > 0) Char(tmp[--i]);
  }

  void Hex(uint64_t v) {
    static const char kDigits[] = "0123456789abcdef";
    char tmp[16];
    int i = 0;
    do {
      tmp[i++] = kDigits[v & 0xF];
      v >>= 4;
    } while (v != 0);
    Str("0x");
    while (i > 0) Char(tmp[--i]);
  }

  void Flush() {
    size_t off = 0;
    while (off < len_) {
      ssize_t n = write(fd_, buf_ + off, len_ - off);
      if (n < 0) {
        if (errno == EINTR) continue;
        break;
      }
      off += static_cast<size_t>(n);
    }
    len_ = 0;
  }

 private:
  int fd_;
  char buf_[512];
  size_t len_ = 0;
};

uintptr_t ContextPc(const ucontext_t* uc) {
  if (uc == nullptr) return 0;
#if defined(__aarch64__)
  return static_cast<uintptr_t>(uc->uc_mcontext.pc);
#elif defined(__x86_64__)
  return static_cast<uintptr_t>(uc->uc_mcontext.gregs[REG_RIP]);
#elif defined(__i386__)
  return static_cast<uintptr_t>(uc->uc_mcontext.gregs[REG_EIP]);
#elif defined(__arm__)
  return static_cast<uintptr_t>(uc->uc_mcontext.arm_pc);
#else
  return 0;
#endif
}

uintptr_t ContextLr(const ucontext_t* uc) {
  if (uc == nullptr) return 0;
#if defined(__aarch64__)
  return static_cast<uintptr_t>(uc->uc_mcontext.regs[30]);
#elif defined(__arm__)
  return static_cast<uintptr_t>(uc->uc_mcontext.arm_lr);
#else
  return 0;
#endif
}

struct UnwindState {
  uintptr_t* pcs;
  int count;
};

_Unwind_Reason_Code UnwindCallback(struct _Unwind_Context* context, void* arg) {
  UnwindState* state = static_cast<UnwindState*>(arg);
  uintptr_t pc = _Unwind_GetIP(context);
  if (pc != 0) {
    state->pcs[state->count++] = pc;
    if (state->count >= kMaxFrames) return _URC_END_OF_STACK;
  }
  return _URC_NO_REASON;
}

// Load bias of a mapped ELF image: its base address minus the vaddr of the first PT_LOAD.
uintptr_t LoadBias(const void* base) {
  const ElfW(Ehdr)* ehdr = static_cast<const ElfW(Ehdr)*>(base);
  const ElfW(Phdr)* phdr = reinterpret_cast<const ElfW(Phdr)*>(static_cast<const char*>(base) + ehdr->e_phoff);
  uintptr_t bias = reinterpret_cast<uintptr_t>(base);
  for (int i = 0; i < ehdr->e_phnum; i++) {
    if (phdr[i].p_type == PT_LOAD && phdr[i].p_offset == 0) return bias - phdr[i].p_vaddr;
  }
  return bias;
}

// Reads the GNU build ID from the ELF notes of an image that is already mapped in memory.
bool BuildId(const void* base, char* out, size_t out_size) {
  const ElfW(Ehdr)* ehdr = static_cast<const ElfW(Ehdr)*>(base);
  if (memcmp(ehdr->e_ident, ELFMAG, SELFMAG) != 0) return false;
  const ElfW(Phdr)* phdr = reinterpret_cast<const ElfW(Phdr)*>(static_cast<const char*>(base) + ehdr->e_phoff);
  uintptr_t bias = LoadBias(base);
  for (int i = 0; i < ehdr->e_phnum; i++) {
    if (phdr[i].p_type != PT_NOTE) continue;
    const char* p = reinterpret_cast<const char*>(bias + phdr[i].p_vaddr);
    const char* end = p + phdr[i].p_memsz;
    while (p + sizeof(ElfW(Nhdr)) <= end) {
      const ElfW(Nhdr)* note = reinterpret_cast<const ElfW(Nhdr)*>(p);
      const char* name = p + sizeof(ElfW(Nhdr));
      const char* desc = name + ((note->n_namesz + 3) & ~3u);
      if (note->n_type == NT_GNU_BUILD_ID && note->n_namesz == 4 && memcmp(name, "GNU", 4) == 0) {
        static const char kDigits[] = "0123456789abcdef";
        size_t n = 0;
        for (uint32_t j = 0; j < note->n_descsz && n + 2 < out_size; j++) {
          uint8_t byte = static_cast<uint8_t>(desc[j]);
          out[n++] = kDigits[byte >> 4];
          out[n++] = kDigits[byte & 0xF];
        }
        out[n] = '\0';
        return n > 0;
      }
      p = desc + ((note->n_descsz + 3) & ~3u);
    }
  }
  return false;
}

// frame <pc> <rel_pc> <build_id|-> <symbol|-> <symbol_offset> <module path>
void WriteFrame(Writer& w, uintptr_t pc, bool exact) {
  // A return address points after the call; pc - 1 lies inside the call instruction itself,
  // which is what symbolizers need to report the calling line.
  uintptr_t lookup = exact ? pc : pc - 1;
  Dl_info info;
  memset(&info, 0, sizeof(info));
  w.Str("frame ");
  w.Hex(pc);
  // dladdr takes the linker lock; acceptable for a best-effort report (Android 12+ tombstones,
  // read through ApplicationExitInfo, are the authoritative backtrace).
  if (dladdr(reinterpret_cast<void*>(lookup), &info) != 0 && info.dli_fbase != nullptr) {
    char build_id[65];
    w.Char(' ');
    w.Hex(lookup - LoadBias(info.dli_fbase));
    w.Char(' ');
    w.Str(BuildId(info.dli_fbase, build_id, sizeof(build_id)) ? build_id : "-");
    w.Char(' ');
    if (info.dli_sname != nullptr) w.Token(info.dli_sname); else w.Char('-');
    w.Char(' ');
    w.Hex(info.dli_saddr != nullptr ? lookup - reinterpret_cast<uintptr_t>(info.dli_saddr) : 0);
    w.Char(' ');
    w.Line(info.dli_fname != nullptr ? info.dli_fname : "?");
  } else {
    w.Str(" 0x0 - - 0x0 ?");
  }
  w.Char('\n');
}

void WriteBacktrace(Writer& w, const ucontext_t* uc) {
  uintptr_t pcs[kMaxFrames];
  UnwindState state = {pcs, 0};
  _Unwind_Backtrace(UnwindCallback, &state);
  uintptr_t crash_pc = ContextPc(uc);
  if (crash_pc == 0) {
    for (int i = 0; i < state.count; i++) WriteFrame(w, pcs[i], i == 0);
    return;
  }
  // The unwinder starts inside this handler; skip to the frame that faulted.
  int start = -1;
  for (int i = 0; i < state.count; i++) {
    if (pcs[i] == crash_pc) {
      start = i;
      break;
    }
  }
  if (start >= 0) {
    for (int i = start; i < state.count; i++) WriteFrame(w, pcs[i], i == start);
    return;
  }
  // The unwinder could not step through the signal frame: report what the CPU context gives.
  WriteFrame(w, crash_pc, true);
  uintptr_t lr = ContextLr(uc);
  if (lr != 0) WriteFrame(w, lr, false);
}

void WriteReport(int sig, const siginfo_t* info, const ucontext_t* uc) {
  int fd = open(g_report_path, O_CREAT | O_WRONLY | O_TRUNC | O_CLOEXEC, 0600);
  if (fd < 0) return;
  {
    Writer w(fd);
    w.Str("blackbox-native-crash 1\n");
    w.Str("session ");
    w.Token(g_session_id);
    w.Char('\n');
    timespec now;
    clock_gettime(CLOCK_REALTIME, &now);
    w.Str("timestamp_ms ");
    w.Dec(static_cast<int64_t>(now.tv_sec) * 1000 + now.tv_nsec / 1000000);
    w.Str("\nsignal ");
    w.Dec(sig);
    w.Char(' ');
    w.Str(SignalName(sig));
    w.Str("\ncode ");
    w.Dec(info != nullptr ? info->si_code : 0);
    w.Str("\nfault_addr ");
    w.Hex(info != nullptr ? reinterpret_cast<uintptr_t>(info->si_addr) : 0);
    w.Str("\npid ");
    w.Dec(getpid());
    w.Str("\ntid ");
    w.Dec(gettid());
    char thread_name[17];
    memset(thread_name, 0, sizeof(thread_name));
    prctl(PR_GET_NAME, thread_name, 0, 0, 0);
    w.Str("\nthread ");
    w.Line(thread_name);
    w.Char('\n');
    WriteBacktrace(w, uc);
    unsigned next = __atomic_load_n(&g_crumb_next, __ATOMIC_ACQUIRE);
    unsigned first = next > kCrumbSlots ? next - kCrumbSlots : 0;
    for (unsigned i = first; i < next; i++) {
      w.Str("crumb ");
      w.Line(g_crumbs[i % kCrumbSlots], kCrumbLength);
      w.Char('\n');
    }
    w.Str("end\n");
  }
  fsync(fd);
  close(fd);
}

void HandleSignal(int sig, siginfo_t* info, void* context) {
  int saved_errno = errno;
  // Several threads can fault at once; only the first one writes a report.
  if (__atomic_exchange_n(&g_handling, 1, __ATOMIC_SEQ_CST) == 0) {
    WriteReport(sig, info, static_cast<const ucontext_t*>(context));
  }
  int index = SignalIndex(sig);
  if (index >= 0) sigaction(sig, &g_previous[index], nullptr);
  // A fault raised by the CPU re-executes the faulting instruction after we return and reaches the
  // restored handler. A signal sent from user space (abort(), kill) must be sent again.
  if (info == nullptr || info->si_code <= 0 || sig == SIGABRT) {
    if (syscall(SYS_rt_tgsigqueueinfo, getpid(), gettid(), sig, info) != 0) {
      syscall(SYS_tgkill, getpid(), gettid(), sig);
    }
  }
  errno = saved_errno;
}

bool CopyJString(JNIEnv* env, jstring source, char* out, size_t out_size) {
  if (source == nullptr) return false;
  jsize length = env->GetStringUTFLength(source);
  if (length <= 0 || static_cast<size_t>(length) >= out_size) return false;
  env->GetStringUTFRegion(source, 0, env->GetStringLength(source), out);
  out[length] = '\0';
  return true;
}

}  // namespace

extern "C" JNIEXPORT jboolean JNICALL
Java_io_github_yasaswini_blackbox_internal_NativeBridge_install(JNIEnv* env, jclass, jstring report_path, jstring session_id) {
  if (g_installed) return JNI_TRUE;
  if (!CopyJString(env, report_path, g_report_path, sizeof(g_report_path)) ||
      !CopyJString(env, session_id, g_session_id, sizeof(g_session_id))) {
    return JNI_FALSE;
  }
  struct sigaction action;
  memset(&action, 0, sizeof(action));
  sigfillset(&action.sa_mask);
  action.sa_sigaction = HandleSignal;
  // Bionic gives every thread an alternate signal stack, so stack overflows can be reported too.
  action.sa_flags = SA_SIGINFO | SA_ONSTACK;
  for (int i = 0; i < kSignalCount; i++) {
    if (sigaction(kSignals[i], &action, &g_previous[i]) != 0) {
      for (int j = 0; j < i; j++) sigaction(kSignals[j], &g_previous[j], nullptr);
      return JNI_FALSE;
    }
  }
  g_installed = 1;
  return JNI_TRUE;
}

extern "C" JNIEXPORT void JNICALL
Java_io_github_yasaswini_blackbox_internal_NativeBridge_pushBreadcrumb(JNIEnv* env, jclass, jstring entry) {
  if (entry == nullptr) return;
  // Modified UTF-8 needs up to 3 bytes per UTF-16 unit.
  char buffer[kCrumbLength * 3];
  jsize chars = env->GetStringLength(entry);
  jsize take = chars < kCrumbLength - 1 ? chars : kCrumbLength - 1;
  env->GetStringUTFRegion(entry, 0, take, buffer);
  size_t bytes = strnlen(buffer, sizeof(buffer) - 1);
  if (bytes > kCrumbLength - 1) bytes = kCrumbLength - 1;
  unsigned slot = __atomic_fetch_add(&g_crumb_next, 1, __ATOMIC_ACQ_REL) % kCrumbSlots;
  memcpy(g_crumbs[slot], buffer, bytes);
  g_crumbs[slot][bytes] = '\0';
}

extern "C" JNIEXPORT jboolean JNICALL
Java_io_github_yasaswini_blackbox_internal_NativeBridge_writeSelfTest(JNIEnv* env, jclass, jstring report_path) {
  char saved[sizeof(g_report_path)];
  memcpy(saved, g_report_path, sizeof(saved));
  bool ok = CopyJString(env, report_path, g_report_path, sizeof(g_report_path));
  if (ok) {
    siginfo_t info;
    memset(&info, 0, sizeof(info));
    info.si_code = SI_USER;
    WriteReport(SIGTRAP, &info, nullptr);
  }
  memcpy(g_report_path, saved, sizeof(saved));
  return ok ? JNI_TRUE : JNI_FALSE;
}
