package design.doop.android

import android.content.*
import android.graphics.Bitmap
import android.graphics.RectF
import android.os.PersistableBundle
import android.webkit.*
import androidx.core.content.FileProvider
import kotlinx.coroutines.*
import org.json.JSONObject
import org.json.JSONTokener
import java.io.ByteArrayInputStream
import java.io.File
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

object SelectionActions {
    suspend fun edit(context:Context,frame:Frame,element:ElementSelection?,action:String,markup:String=""):String = withContext(Dispatchers.Main) {
        require(element==null || element.html==frame.html) { "This selection changed. Select it again." }
        withTimeout(10000) { suspendCancellableCoroutine { continuation ->
            val web=WebView(context)
            web.settings.apply { javaScriptEnabled=true;blockNetworkLoads=true;allowFileAccess=false;allowContentAccess=false;domStorageEnabled=false }
            continuation.invokeOnCancellation { android.os.Handler(android.os.Looper.getMainLooper()).post { web.destroy() } }
            web.webViewClient=object:WebViewClient() {
                override fun shouldInterceptRequest(view:WebView,request:WebResourceRequest)=WebResourceResponse("text/plain","UTF-8",ByteArrayInputStream(byteArrayOf()))
                override fun onPageFinished(view:WebView,url:String) {
                    val script=context.assets.open("SelectionDOM.js").bufferedReader().use { it.readText() }
                    val args=listOf(frame.html,element?.selector ?: "",action,markup).joinToString(",") { JSONObject.quote(it) }
                    view.evaluateJavascript("(function(){try{$script;return JSON.stringify({value:doopEditSelection($args)});}catch(e){return JSON.stringify({error:e.message});}})()") { result ->
                        try {
                            val response=JSONObject(JSONTokener(result).nextValue() as String)
                            response.string("error")?.let { error(it) }
                            if(continuation.isActive) continuation.resume(response.getString("value"))
                        } catch(e:Exception) { if(continuation.isActive) continuation.resumeWithException(e) }
                        finally { web.destroy() }
                    }
                }
            }
            web.loadDataWithBaseURL("https://selection.invalid/","<meta http-equiv='Content-Security-Policy' content=\"default-src 'none'\"><body></body>","text/html","UTF-8",null)
        } }
    }
    suspend fun copy(context:Context,frame:Frame,element:ElementSelection?) {
        val markup=if(element==null) null else edit(context,frame,element,"copy")
        val payload=obj("frame" to frame.json(),"markup" to markup).toString()
        // Android's clipboard travels through Binder. Leave room for both text
        // representations and metadata rather than overflowing its 1 MB buffer.
        require(payload.toByteArray().size + (markup ?: frame.html).toByteArray().size*2 < 500000) { "This design is too large for the Android clipboard. Export its HTML instead." }
        val clip=ClipData.newHtmlText("Doop selection",markup ?: frame.html,markup ?: frame.html)
        clip.description.extras=PersistableBundle().apply { putString("doop.selection",payload) }
        context.getSystemService(ClipboardManager::class.java).setPrimaryClip(clip)
    }
    suspend fun paste(context:Context,model:CanvasModel) {
        val raw=context.getSystemService(ClipboardManager::class.java).primaryClip?.description?.extras?.getString("doop.selection") ?: error("Copy a frame or element in Doop first.")
        require(raw.length<=16*1024*1024) { "This clipboard item is too large." }
        val value=JSONObject(raw);val source=Frame.parse(value.getJSONObject("frame"));val markup=value.string("markup")
        if(markup==null) model.addFrame(source) else {
            val target=model.selected ?: error("Select a frame to paste this element into.")
            val html=edit(context,target,model.element,"paste",markup)
            model.patchFrame(target,obj("html" to html))
        }
    }
    fun link(model:CanvasModel,frame:Frame?=model.selected,element:ElementSelection?=model.element):String = android.net.Uri.parse(model.client.server.origin+"/c/"+model.id).buildUpon().apply {
        frame?.let { appendQueryParameter("frame",it.id) };element?.let { appendQueryParameter("selector",it.selector) }
    }.build().toString()
    fun shareText(context:Context,text:String) { context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT,text),"Share")) }
    suspend fun export(context:Context,model:CanvasModel,frame:Frame,element:ElementSelection?,image:Boolean) {
        if(element!=null) edit(context,frame,element,"copy") // reject an ambiguous/stale selector before exporting
        val directory=File(context.cacheDir,"exports").apply { mkdirs() }
        // Export files are short-lived, private cache files. Clean only this app's old exports.
        directory.listFiles()?.filter { System.currentTimeMillis()-it.lastModified()>24*60*60*1000 }?.forEach { it.delete() }
        val file=File(directory,"${frame.name.replace(Regex("[^a-zA-Z0-9_-]"),"_").take(60).ifEmpty { "design" }}-${System.currentTimeMillis()}.${if(image) "png" else "html"}")
        if(image) {
            val bitmap=withContext(BlitzNative.dispatcher) {
                val ptr=BlitzNative.create(frame.html.toByteArray(),model.client.server.origin.toByteArray(),frame.width.toInt(),frame.height.toInt())
                check(ptr!=0L)
                try {
                    val full=RectF(0f,0f,frame.width,frame.height)
                    var ready=false
                    repeat(100) {
                        if(!ready) {
                            BlitzNative.paint(ptr,full,.2f).recycle()
                            if(!BlitzNative.loading(ptr)) ready=true else delay(100)
                        }
                    }
                    check(ready) { "Images or fonts are still loading. Try exporting again." }
                    val region=if(element==null) full else {
                        val info=BlitzNative.pick(ptr,0f,0f,element.selector.toByteArray()) ?: error("Could not find this element in the export.")
                        val e=ElementSelection.parse(frame,JSONObject(info.toString(Charsets.UTF_8)))
                        RectF(e.x,e.y,e.x+e.width,e.y+e.height).apply { check(intersect(full)) { "The selection has no visible image area." } }
                    }
                    BlitzNative.paint(ptr,region,2f,pixelBudget=8_000_000f)
                } finally { BlitzNative.destroy(ptr) }
            }
            withContext(Dispatchers.IO) { file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG,100,it) };bitmap.recycle() }
        } else {
            val markup=if(element==null) frame.html else edit(context,frame,element,"copy")
            withContext(Dispatchers.IO) { file.writeText(markup) }
        }
        val uri=FileProvider.getUriForFile(context,context.packageName+".exports",file)
        context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType(if(image) "image/png" else "text/html")
            .putExtra(Intent.EXTRA_STREAM,uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION).apply { clipData=ClipData.newRawUri("Design export",uri) },"Export design"))
    }
}
