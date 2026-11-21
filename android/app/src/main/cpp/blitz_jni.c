#include <jni.h>
#include <android/bitmap.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <unistd.h>
#include "doopblitz.h"

// Java modified UTF-8 does not preserve emoji. Kotlin sends standard UTF-8 bytes.
static char *utf8(JNIEnv *env, jbyteArray bytes) {
    if (!bytes) return NULL;
    jsize size = (*env)->GetArrayLength(env, bytes);
    char *out = calloc((size_t)size + 1, 1);
    if (out) (*env)->GetByteArrayRegion(env, bytes, 0, size, (jbyte *)out);
    return out;
}
static DoopBlitzDoc *doc(jlong ptr) { return (DoopBlitzDoc *)(uintptr_t)ptr; }
#define JNI_METHOD(name) Java_design_doop_android_BlitzNative_##name

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM *vm, void *reserved) {
    // The shared Rust HTTP client uses OpenSSL. Android's trust store is not in
    // OpenSSL's desktop default location; use the OS-managed CA directory.
    const char *certs = access("/apex/com.android.conscrypt/cacerts", R_OK) == 0
        ? "/apex/com.android.conscrypt/cacerts" : "/system/etc/security/cacerts";
    setenv("SSL_CERT_DIR", certs, 1);
    return JNI_VERSION_1_6;
}

JNIEXPORT jlong JNICALL JNI_METHOD(create)(JNIEnv *env, jobject self, jbyteArray html, jbyteArray base, jint w, jint h) {
    if (w < 1 || h < 1 || w > 10000 || h > 10000) return 0;
    char *markup = utf8(env, html), *url = utf8(env, base);
    DoopBlitzDoc *value = markup && url ? doopblitz_doc_new(markup, url, w, h, 1) : NULL;
    free(markup); free(url);
    return (jlong)(uintptr_t)value;
}
JNIEXPORT void JNICALL JNI_METHOD(destroy)(JNIEnv *env, jobject self, jlong ptr) {
    if (ptr) doopblitz_doc_free(doc(ptr));
}
JNIEXPORT jboolean JNICALL JNI_METHOD(loading)(JNIEnv *env, jobject self, jlong ptr) {
    return ptr && doopblitz_doc_loading(doc(ptr));
}
JNIEXPORT jboolean JNICALL JNI_METHOD(animating)(JNIEnv *env, jobject self, jlong ptr) {
    return ptr && doopblitz_doc_is_animating(doc(ptr));
}
JNIEXPORT jbyteArray JNICALL JNI_METHOD(pick)(JNIEnv *env, jobject self, jlong ptr, jfloat x, jfloat y, jbyteArray selector) {
    if (!ptr) return NULL;
    char *query = utf8(env, selector);
    uint64_t node = query ? doopblitz_doc_query_selector(doc(ptr), query) : doopblitz_doc_pick_from_point(doc(ptr), x, y);
    free(query);
    if (!node) return NULL;
    char *info = doopblitz_node_info(doc(ptr), node);
    if (!info) return NULL;
    jsize size = (jsize)strlen(info);
    jbyteArray bytes = (*env)->NewByteArray(env, size);
    if (bytes) (*env)->SetByteArrayRegion(env, bytes, 0, size, (jbyte *)info);
    doopblitz_string_free(info);
    return bytes;
}
JNIEXPORT jboolean JNICALL JNI_METHOD(render)(JNIEnv *env, jobject self, jlong ptr, jobject bitmap,
    jfloat scale, jfloat x, jfloat y, jfloat w, jfloat h, jdouble time) {
    if (!ptr || !bitmap || !isfinite(scale) || scale <= 0 || w <= 0 || h <= 0) return JNI_FALSE;
    AndroidBitmapInfo info;
    if (AndroidBitmap_getInfo(env, bitmap, &info) != ANDROID_BITMAP_RESULT_SUCCESS || info.format != ANDROID_BITMAP_FORMAT_RGBA_8888) return JNI_FALSE;
    if (info.width > 4096 || info.height > 4096 || (uint64_t)info.width * info.height > 8000000) return JNI_FALSE;
    uint32_t rw = 0, rh = 0; size_t size = 0;
    uint8_t *rgba = doopblitz_doc_render_region_at(doc(ptr), time, scale, x, y, w, h, &rw, &rh, &size);
    if (!rgba) return JNI_FALSE;
    void *pixels = NULL;
    bool valid = rw == info.width && rh == info.height && size >= (size_t)rw * rh * 4;
    if (valid && AndroidBitmap_lockPixels(env, bitmap, &pixels) == ANDROID_BITMAP_RESULT_SUCCESS) {
        for (uint32_t row = 0; row < rh; row++) memcpy((uint8_t *)pixels + row * info.stride, rgba + row * rw * 4, rw * 4);
        AndroidBitmap_unlockPixels(env, bitmap);
    } else valid = false;
    doopblitz_buffer_free(rgba, size);
    return valid;
}
