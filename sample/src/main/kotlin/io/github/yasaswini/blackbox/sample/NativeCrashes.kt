package io.github.yasaswini.blackbox.sample

/** JNI into libcrashy.so: real native failures for the crash handler to catch. */
object NativeCrashes {
    init {
        System.loadLibrary("crashy")
    }

    /** Dereferences a missing order record (SIGSEGV at a small address). */
    @JvmStatic
    external fun applyDiscountToMissingOrder()

    /** Copies [label] into an 8-byte buffer; bionic's FORTIFY aborts the process (SIGABRT). */
    @JvmStatic
    external fun printReceiptLabel(label: String)
}
