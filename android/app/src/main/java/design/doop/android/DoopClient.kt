package design.doop.android

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.security.KeyStore
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

class ApiException(val status: Int, message: String, val frame: JSONObject? = null) : IOException(message)

/** Cookies are encrypted with a non-exportable Android Keystore key, partitioned by server. */
class SessionCookies(context: Context, private val server: ServerAddress) : CookieJar {
    private val prefs = context.getSharedPreferences("sessions", Context.MODE_PRIVATE)
    private val storageKey = MessageDigest.getInstance("SHA-256").digest(server.origin.toByteArray()).joinToString("") { "%02x".format(it) }
    private val cookies = mutableListOf<Cookie>()
    private var closed = false
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey("doop.sessions", null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder("doop.sessions", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    init {
        runCatching {
            val raw = prefs.getString(storageKey, null) ?: return@runCatching
            val bytes = Base64.decode(raw, Base64.NO_WRAP)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0,12)))
            val saved = JSONArray(String(cipher.doFinal(bytes.copyOfRange(12,bytes.size)), Charsets.UTF_8))
            for (i in 0 until saved.length()) Cookie.parse(server.url, saved.getString(i))?.let(cookies::add)
        }.onFailure { prefs.edit().remove(storageKey).apply() }
    }
    @Synchronized override fun saveFromResponse(url: HttpUrl, received: List<Cookie>) {
        if (closed || url.host != server.url.host || url.port != server.url.port || url.scheme != server.url.scheme) return
        received.forEach { c -> cookies.removeAll { it.name == c.name && it.domain == c.domain && it.path == c.path }; cookies.add(c) }
        cookies.removeAll { it.expiresAt <= System.currentTimeMillis() }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        val encrypted = cipher.iv + cipher.doFinal(JSONArray(cookies.map { it.toString() }).toString().toByteArray())
        prefs.edit().putString(storageKey, Base64.encodeToString(encrypted,Base64.NO_WRAP)).apply()
    }
    @Synchronized override fun loadForRequest(url: HttpUrl) = if (closed || url.host != server.url.host || url.port != server.url.port || url.scheme != server.url.scheme) emptyList() else cookies.filter { it.expiresAt > System.currentTimeMillis() && it.matches(url) }
    @Synchronized fun clear() { closed = true; cookies.clear(); prefs.edit().remove(storageKey).apply() }
}

class DoopClient(context: Context, val server: ServerAddress) {
    val cookies = SessionCookies(context, server)
    val http = OkHttpClient.Builder().cookieJar(cookies).connectTimeout(20,TimeUnit.SECONDS)
        .readTimeout(30,TimeUnit.SECONDS).pingInterval(20,TimeUnit.SECONDS)
        .followRedirects(false).followSslRedirects(false).build()
    fun request(path: String, method: String = "GET", body: JSONObject? = null): Request = Request.Builder()
        .url(server.api(path)).header("Origin", server.origin).header("Accept","application/json")
        .method(method, if (method in listOf("GET","HEAD")) null else (body?.toString() ?: "{}").toRequestBody("application/json; charset=utf-8".toMediaType())).build()

    suspend fun data(path: String, method: String = "GET", body: JSONObject? = null): String = suspendCancellableCoroutine { continuation ->
        val call = http.newCall(request(path,method,body))
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(object: Callback {
            override fun onFailure(call: Call, e: IOException) { if (continuation.isActive) continuation.resumeWithException(e) }
            override fun onResponse(call: Call, response: Response) {
                try {
                    val text = response.use {
                        val bytes = it.body?.byteStream()?.use { stream ->
                            val output = java.io.ByteArrayOutputStream()
                            val chunk = ByteArray(16384)
                            while (true) {
                                val count=stream.read(chunk)
                                if(count < 0) break
                                require(output.size()+count <= 64*1024*1024) { "This response is too large to open on Android." }
                                output.write(chunk,0,count)
                            }
                            output.toByteArray()
                        } ?: byteArrayOf()
                        require(bytes.size <= 64*1024*1024) { "This response is too large to open on Android." }
                        val text = bytes.toString(Charsets.UTF_8)
                        if (!it.isSuccessful) {
                            val error = runCatching { JSONObject(text) }.getOrNull()
                            val detail = error?.string("message") ?: error?.string("error")
                            throw ApiException(it.code, if (detail == "resident_limit") "Your agent allowance is used up. Connect a model account in account settings." else detail ?: "Request failed (${it.code}).", error?.optJSONObject("frame"))
                        }
                        text
                    }
                    if (continuation.isActive) continuation.resume(text)
                } catch(e: Exception) { if (continuation.isActive) continuation.resumeWithException(e) }
            }
        })
    }
    suspend fun json(path: String, method: String = "GET", body: JSONObject? = null) = JSONObject(data(path,method,body))
    suspend fun list(path: String) = JSONArray(data(path)).objects()
    fun close() { http.dispatcher.cancelAll(); http.connectionPool.evictAll() }
}
