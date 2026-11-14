package design.doop.android

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import org.json.JSONArray
import org.json.JSONObject
import java.security.SecureRandom

fun obj(vararg pairs: Pair<String, Any?>) = JSONObject().apply { pairs.forEach { (k,v) -> put(k, v ?: JSONObject.NULL) } }
fun JSONObject.string(key: String): String? = if (isNull(key)) null else optString(key).takeIf { it.isNotEmpty() }
fun JSONObject.objects(key: String): List<JSONObject> = optJSONArray(key)?.objects() ?: emptyList()
fun JSONArray.objects(): List<JSONObject> = (0 until length()).mapNotNull { optJSONObject(it) }

data class ServerAddress(val url: HttpUrl) {
    val origin = url.toString().trimEnd('/')
    companion object {
        fun parse(text: String, allowLocal: Boolean = false): ServerAddress {
            val u = text.trim().toHttpUrlOrNull() ?: error("Enter a complete HTTPS server address.")
            require(u.isHttps || (allowLocal && u.host in listOf("localhost", "127.0.0.1", "10.0.2.2"))) { "Use HTTPS for your server." }
            require(u.username.isEmpty() && u.password.isEmpty() && u.encodedPath == "/" && u.query == null && u.fragment == null) { "Enter only the server origin, without a path or credentials." }
            return ServerAddress(u)
        }
    }
    fun api(path: String): HttpUrl {
        require(path.startsWith('/') && !path.startsWith("//"))
        val target = url.resolve(path) ?: error("Invalid URL")
        require(target.host == url.host && target.scheme == url.scheme && target.port == url.port)
        return target
    }
}

data class Frame(val id: String, val canvasId: String, val name: String, val x: Float, val y: Float,
    val width: Float, val height: Float, val html: String, val pageId: String? = null,
    val hidden: Boolean = false, val locked: Boolean = false, val updatedAt: Long = 0,
    val z: Double? = null, val rotation: Double? = null) {
    fun body() = obj("name" to name, "x" to x, "y" to y, "width" to width, "height" to height,
        "html" to html, "hidden" to hidden, "locked" to locked).apply {
        pageId?.let { put("pageId", it) }; z?.let { put("z", it) }; rotation?.let { put("rotation", it) }
    }
    fun json() = body().put("id", id).put("canvasId", canvasId).put("updatedAt", updatedAt)
    companion object {
        fun parse(o: JSONObject) = Frame(o.getString("id"), o.optString("canvasId"), o.optString("name", "Untitled frame"),
            o.optDouble("x", 0.0).toFloat(), o.optDouble("y", 0.0).toFloat(),
            o.getDouble("width").toFloat(), o.getDouble("height").toFloat(), o.optString("html"),
            o.string("pageId"), o.optBoolean("hidden"), o.optBoolean("locked"), o.optLong("updatedAt"),
            if(o.isNull("z")) null else o.getDouble("z"), if(o.isNull("rotation")) null else o.getDouble("rotation")).also {
            require(it.width.isFinite() && it.height.isFinite() && it.width in 1f..10000f && it.height in 1f..10000f && it.x.isFinite() && it.y.isFinite()) { "Invalid frame dimensions" }
        }
    }
}
data class Page(val id: String, val name: String)
data class Board(val id: String, val name: String, val frames: List<Frame>, val pages: List<Page>) {
    fun pageOf(frame: Frame) = frame.pageId ?: pages.first().id
    companion object {
        fun parse(o: JSONObject): Board {
            val id = o.getString("id")
            return Board(id, o.optString("name", "Untitled canvas"), o.objects("frames").map(Frame::parse),
                o.objects("pages").map { Page(it.getString("id"), it.optString("name", "Page")) }
                    .ifEmpty { listOf(Page("$id:page1", "Page 1")) })
        }
    }
}
data class ElementSelection(val frameId: String, val html: String, val selector: String, val label: String,
    val text: String, val x: Float, val y: Float, val width: Float, val height: Float) {
    companion object {
        fun parse(frame: Frame, o: JSONObject): ElementSelection {
            val r = o.getJSONArray("rect")
            val label = o.optString("tag") + (o.string("idAttr")?.let { "#$it" } ?: "")
            return ElementSelection(frame.id, frame.html, o.getString("selector"), label, o.optString("text"),
                r.getDouble(0).toFloat(), r.getDouble(1).toFloat(), r.getDouble(2).toFloat(), r.getDouble(3).toFloat())
        }
    }
}

data class AuthAttempt(val challenge: String, val origin: String, val started: Long) {
    fun token(callback: java.net.URI, now: Long = System.currentTimeMillis()): String? {
        if (callback.scheme != "doop" || callback.host != "auth" || now - started !in 0..600000) return null
        val parts = callback.rawQuery.orEmpty().split('&').mapNotNull {
            val p = it.split('=', limit = 2)
            if (p.size != 2) null else java.net.URLDecoder.decode(p[0], "UTF-8") to java.net.URLDecoder.decode(p[1], "UTF-8")
        }
        if (parts.map { it.first }.distinct().size != parts.size) return null
        val query = parts.toMap()
        return query["token"]?.takeIf { it.isNotBlank() && query["challenge"] == challenge }
    }
    companion object {
        fun create(origin: String) = AuthAttempt(ByteArray(16).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }, origin, System.currentTimeMillis())
    }
}

data class SnapResult(val x: Float, val y: Float, val guideX: Float?, val guideY: Float?)
fun snapFrame(frame: Frame, x: Float, y: Float, others: List<Frame>, zoom: Float): SnapResult {
    if (!zoom.isFinite() || zoom <= 0) return SnapResult(x,y,null,null)
    fun axis(base: Float, size: Float, horizontal: Boolean): Pair<Float, Float?> {
        var delta = Float.POSITIVE_INFINITY; var guide: Float? = null
        for (f in others.filter { it.id != frame.id && !it.hidden }) {
            val b = if (horizontal) f.x else f.y; val s = if (horizontal) f.width else f.height
            for (at in listOf(b,b+s/2,b+s)) for (off in listOf(0f,size/2,size)) {
                val d = at-base-off
                if (kotlin.math.abs(d) <= 8/zoom && kotlin.math.abs(d) < kotlin.math.abs(delta)) { delta=d;guide=at }
            }
        }
        return (base + if (guide == null) 0f else delta) to guide
    }
    val sx=axis(x,frame.width,true);val sy=axis(y,frame.height,false)
    return SnapResult(sx.first,sy.first,sx.second,sy.second)
}

/** Fit large boards too; the gesture floor must not crop tall pages during fit. */
fun canvasFitScale(contentWidth:Float,contentHeight:Float,availableWidth:Float,availableHeight:Float,density:Float):Float =
    minOf(availableWidth/contentWidth.coerceAtLeast(1f),availableHeight/contentHeight.coerceAtLeast(1f))
        .coerceIn(.0001f*density,4f*density)

/** The API resolves the default already; never edit a different account's model. */
data class AccountModelSelection(val kind:String, val model:String?, val options:List<JSONObject>) {
    val label get()=options.find { it.optString("id")==model }?.string("name") ?: model ?: "Auto"
    companion object {
        fun parse(view:JSONObject):AccountModelSelection? {
            val kind=view.string("default") ?: return null
            val account=view.objects("accounts").find { it.optString("kind")==kind && it.optBoolean("enabled") } ?: return null
            return AccountModelSelection(kind,account.string("model"),view.optJSONObject("menus")?.objects(kind) ?: emptyList())
        }
    }
}
