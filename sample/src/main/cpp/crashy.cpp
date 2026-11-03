// Deliberately buggy native code for the sample app's crash scenarios.
#include <android/log.h>
#include <jni.h>
#include <string.h>

struct OrderRecord {
  int id;
  int total_paise;
  int discount_percent;
};

extern "C" {

// Global and mutable, so the compiler cannot prove the lookups below return null.
OrderRecord* g_order_cache[4] = {nullptr, nullptr, nullptr, nullptr};

__attribute__((noinline)) OrderRecord* blackbox_sample_find_order(int order_id) {
  return g_order_cache[order_id % 4];
}

__attribute__((noinline)) void blackbox_sample_apply_discount(OrderRecord* order, int percent) {
  // Bug: no null check. order is null, so this reads address 0x4 and the process gets SIGSEGV.
  order->total_paise = order->total_paise * (100 - percent) / 100;
  order->discount_percent = percent;
}

__attribute__((noinline)) void blackbox_sample_checkout(int order_id) {
  blackbox_sample_apply_discount(blackbox_sample_find_order(order_id), 10);
}

__attribute__((noinline)) void blackbox_sample_format_label(const char* sku) {
  char label[8];
  // Bug: the SKU does not fit. With _FORTIFY_SOURCE this becomes __strcpy_chk, which aborts.
  strcpy(label, sku);
  __android_log_print(ANDROID_LOG_INFO, "crashy", "label %s", label);
}

JNIEXPORT void JNICALL
Java_io_github_yasaswini_blackbox_sample_NativeCrashes_applyDiscountToMissingOrder(JNIEnv*, jclass) {
  blackbox_sample_checkout(42);
}

JNIEXPORT void JNICALL
Java_io_github_yasaswini_blackbox_sample_NativeCrashes_printReceiptLabel(JNIEnv* env, jclass, jstring label) {
  const char* chars = env->GetStringUTFChars(label, nullptr);
  blackbox_sample_format_label(chars);
  env->ReleaseStringUTFChars(label, chars);
}

}  // extern "C"
