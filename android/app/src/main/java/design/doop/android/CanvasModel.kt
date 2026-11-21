package design.doop.android

import androidx.compose.runtime.*
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.*
import okio.ByteString
import org.json.JSONObject
import java.util.UUID

class CanvasModel(val id:String,val client:DoopClient,private val userName:String,parent:CoroutineScope) {
    private val scope=CoroutineScope(parent.coroutineContext+SupervisorJob(parent.coroutineContext[Job]))
    var board by mutableStateOf<Board?>(null);private set
    var tasks by mutableStateOf<List<JSONObject>>(emptyList());private set
    var comments by mutableStateOf<List<JSONObject>>(emptyList());private set
    var presences by mutableStateOf<List<JSONObject>>(emptyList());private set
    var streams by mutableStateOf<Map<String,JSONObject>>(emptyMap());private set
    var activePage by mutableStateOf("$id:page1");private set
    var selectedId by mutableStateOf<String?>(null);private set
    var element by mutableStateOf<ElementSelection?>(null)
    var connected by mutableStateOf(false);private set
    var connecting by mutableStateOf(false);private set
    var connectionError by mutableStateOf<String?>(null);private set
    var error by mutableStateOf<String?>(null)
    var previewError by mutableStateOf<String?>(null)
    var deleted by mutableStateOf(false);private set
    var busy by mutableStateOf(false);private set
    var viewportCommand by mutableIntStateOf(0)
    var modelAccount by mutableStateOf(JSONObject());private set
    private var history by mutableStateOf<List<Undo>>(emptyList())
    private data class Undo(val type:String,val frameId:String,val body:JSONObject,val expectedUpdatedAt:Long)
    private var socket:WebSocket?=null
    private var generation=0
    private var active=false
    private var reconnect:Job?=null
    private val clientId="android-${UUID.randomUUID()}"
    private val pendingMoves=mutableMapOf<String,Pair<Float,Float>>()
    private val receiveMutex=Mutex()
    val pages get()=board?.pages ?: listOf(Page("$id:page1","Page 1"))
    val pageFrames get()=board?.let { b -> b.frames.filter { b.pageOf(it)==activePage } } ?: emptyList()
    val selected get()=pageFrames.find { it.id==selectedId }
    val canEdit get()=connected && !busy
    val canUndo get()=canEdit && history.isNotEmpty()
    val pageComments get():List<JSONObject> {
        val ids=pageFrames.map { it.id }.toSet()
        val roots=comments.filter { it.string("parentId")==null && (it.string("frameId")?.let(ids::contains) ?: (it.string("pageId")==activePage)) }.map { it.getString("id") }.toSet()
        return comments.filter { (it.string("parentId") ?: it.getString("id")) in roots }
    }
    fun action(block:suspend ()->Unit) { scope.launch { try { block() } catch(e:CancellationException) { throw e } catch(e:Exception) { error=e.message } } }
    fun start() {
        if(active || deleted) return
        active=true;connectionError=null;connect()
        action { modelAccount=client.json("/api/model-account") }
    }
    fun stop() {
        active=false;generation++;reconnect?.cancel();reconnect=null
        socket?.cancel();socket=null;connected=false;connecting=false
    }
    fun dispose() { stop();scope.cancel() }
    private fun connect() {
        if(!active) return
        val current=++generation;connecting=true
        socket=client.http.newWebSocket(client.request("/ws"),object:WebSocketListener() {
            override fun onOpen(ws:WebSocket,response:Response) {
                scope.launch {
                    if(current!=generation || !active) { ws.cancel();return@launch }
                    ws.send(obj("type" to "join","canvasId" to id,"clientId" to clientId,"name" to userName,"kind" to "user").toString())
                }
            }
            override fun onMessage(ws:WebSocket,text:String) { receive(current,ws,text) }
            override fun onMessage(ws:WebSocket,bytes:ByteString) { receive(current,ws,bytes.utf8()) }
            override fun onClosing(ws:WebSocket,code:Int,reason:String) { ws.close(code,null);failed(current,code) }
            override fun onFailure(ws:WebSocket,t:Throwable,response:Response?) { failed(current,when(response?.code) {401->4401;403->4403;404->4404;else->0}) }
        })
    }
    private fun receive(current:Int,ws:WebSocket,text:String) {
        scope.launch {
            receiveMutex.withLock {
                if(current!=generation || !active) return@withLock
                if(text.length > 64*1024*1024 || text.toByteArray().size > 64*1024*1024) { failed(current,1009);ws.cancel();return@withLock }
                try {
                    val event=withContext(Dispatchers.Default) { JSONObject(text) }
                    if(current==generation && active) apply(event)
                } catch(e:CancellationException) { throw e } catch(_:Exception) { failed(current,1007);ws.cancel() }
            }
        }
    }
    private fun failed(current:Int,code:Int) { scope.launch {
        if(current!=generation || !active) return@launch
        generation++;socket?.cancel();socket=null;connected=false
        val message=when(code) {
            4401->"Your session expired. Return to the library and sign in again."
            4403->"You no longer have access to this canvas."
            4404->"This canvas no longer exists."
            1009->"This canvas is too large to load live. Open it in the web app."
            1007->"This canvas update could not be read. Reopen the canvas to try again."
            else->null
        }
        connectionError=message ?: "Connection interrupted. Reconnecting…"
        connecting=message==null
        if(message!=null) { active=false;if(code==4404) deleted=true;return@launch }
        reconnect=scope.launch { delay(2000);connect() }
    } }
    private fun send(o:JSONObject) { if(connected) socket?.send(o.toString()) }
    fun presence(x:Float,y:Float,zoom:Float,width:Float,height:Float,cursorX:Float?=null,cursorY:Float?=null) {
        send(obj("type" to "viewport","viewport" to obj("pageId" to activePage,"x" to x,"y" to y,"zoom" to zoom,"width" to width,"height" to height)))
        if(cursorX!=null && cursorY!=null) send(obj("type" to "cursor","x" to cursorX,"y" to cursorY))
    }
    fun select(id:String?) {
        board?.frames?.find { it.id==id }?.let { activePage=board!!.pageOf(it) }
        selectedId=id;element=null;send(obj("type" to "editing","frameId" to id))
    }
    fun selectPage(id:String) {
        if(id==activePage || pages.none { it.id==id }) return
        activePage=id;select(null);viewportCommand++
    }
    private fun reconcile() {
        val b=board ?: return
        if(pages.none { it.id==activePage }) { activePage=pages.first().id;viewportCommand++ }
        if(selectedId!=null && pageFrames.none { it.id==selectedId }) select(null)
        element?.let { e -> if(b.frames.none { it.id==e.frameId && it.html==e.html }) element=null }
    }
    private fun upsert(frame:Frame) {
        val b=board ?: return
        val f=pendingMoves[frame.id]?.let { frame.copy(x=it.first,y=it.second) } ?: frame
        board=b.copy(frames=if(b.frames.any { it.id==f.id }) b.frames.map { if(it.id==f.id) f else it } else b.frames+f)
    }
    private fun items(list:List<JSONObject>,item:JSONObject,key:String="id")=if(list.any { it.optString(key)==item.optString(key) }) list.map { if(it.optString(key)==item.optString(key)) item else it } else list+item
    private fun apply(e:JSONObject) {
        when(e.getString("type")) {
            "init"->{
                val next=Board.parse(e.getJSONObject("canvas"))
                board=next.copy(frames=next.frames.map { f -> pendingMoves[f.id]?.let { f.copy(x=it.first,y=it.second) } ?: f })
                tasks=e.objects("tasks");comments=e.objects("comments");presences=e.objects("presences");streams=emptyMap()
                connected=true;connecting=false;connectionError=null
            }
            "frame:created","frame:updated"->upsert(Frame.parse(e.getJSONObject("frame")))
            "frame:deleted"->{ val fid=e.getString("frameId");board=board?.copy(frames=board!!.frames.filter { it.id!=fid });streams=streams-fid }
            "frame:drag"->{
                val fid=e.optString("frameId")
                if(fid !in pendingMoves) board?.frames?.find { it.id==fid }?.let { f ->
                    upsert(f.copy(x=e.optDouble("x",f.x.toDouble()).toFloat(),y=e.optDouble("y",f.y.toDouble()).toFloat(),
                        width=e.optDouble("width",f.width.toDouble()).toFloat(),height=e.optDouble("height",f.height.toDouble()).toFloat()))
                }
            }
            "canvas:renamed"->board=board?.copy(name=e.getString("name"))
            "canvas:pages"->board?.let { b ->
                val pages=e.objects("pages").map { Page(it.getString("id"),it.getString("name")) }
                if(pages.isNotEmpty()) board=b.copy(pages=pages,frames=b.frames.map { it.copy(pageId=b.pageOf(it)) })
            }
            "canvas:deleted"->{deleted=true;stop()}
            "task"->tasks=items(tasks,e.getJSONObject("task"))
            "comment"->comments=items(comments,e.getJSONObject("comment"))
            "presence:join"->presences=items(presences,e.getJSONObject("presence"),"clientId")
            "presence:leave"->presences=presences.filter { it.optString("clientId")!=e.optString("clientId") }
            "editing","viewport","cursor"->{
                presences=presences.map { p -> if(p.optString("clientId")!=e.optString("clientId")) p else JSONObject(p.toString()).apply {
                    when(e.optString("type")) {
                        "editing"->put("activeFrameId",e.opt("frameId"))
                        "viewport"->put("viewport",e.opt("viewport"))
                        "cursor"->put("cursor",obj("x" to e.optDouble("x"),"y" to e.optDouble("y")))
                    }
                } }
            }
            "frame:streaming"->{val fid=e.getString("frameId");streams=if(e.optBoolean("active")) streams+(fid to e.getJSONObject("actor")) else streams-fid}
        }
        reconcile()
    }
    private suspend fun <T> edit(block:suspend ()->T):T {
        check(canEdit) { "Connect to the canvas and wait for the current edit to finish." }
        busy=true
        try { return block() } catch(e:ApiException) {
            if(e.status==409) e.frame?.let { upsert(Frame.parse(it)) }
            throw e
        } finally { busy=false;reconcile() }
    }
    private fun record(entry:Undo) { history=(history+entry).takeLast(100) }
    suspend fun addFrame(source:Frame?=null) = edit {
        val page=activePage
        val right=pageFrames.maxOfOrNull { it.x+it.width } ?: -80f
        val body=source?.body()?.put("name",source.name+" copy")?.apply { remove("z") } ?: obj("name" to "Untitled frame","width" to 390,"height" to 844,
            "html" to "<!doctype html><html><body style='margin:0;background:white;display:grid;place-items:center;height:100vh;font-family:system-ui;color:#777'><p>What will you make?</p></body></html>")
        body.put("x",right+80).put("y",0).put("pageId",page)
        val f=Frame.parse(client.json("/api/canvases/$id/frames","POST",body));upsert(f)
        record(Undo("create",f.id,JSONObject(),f.updatedAt));if(activePage==page) {select(f.id);viewportCommand++}
    }
    suspend fun patchFrame(frame:Frame,patch:JSONObject) = edit {
        val current=board?.frames?.find { it.id==frame.id } ?: error("This frame was deleted.")
        check(!current.locked || patch.keys().asSequence().toList()==listOf("locked")) { "Unlock the frame before editing it." }
        if(patch.has("html")) check(current.html==frame.html) { "This design changed. Select it again before editing." }
        val inverse=JSONObject();val before=(if(frame.id in pendingMoves) frame else current).body()
        patch.keys().forEach { key -> inverse.put(key,before.opt(key) ?: JSONObject.NULL) }
        val saved=Frame.parse(client.json("/api/frames/${frame.id}","PATCH",JSONObject(patch.toString()).put("expectedUpdatedAt",frame.updatedAt)))
        if(board?.frames?.any { it.id==frame.id }==true) upsert(saved)
        record(Undo("update",frame.id,inverse,saved.updatedAt))
    }
    fun moveFrame(frame:Frame,x:Float,y:Float) = action {
        if(!canEdit || frame.locked || !x.isFinite() || !y.isFinite() || kotlin.math.abs(x)>1_000_000 || kotlin.math.abs(y)>1_000_000) return@action
        pendingMoves[frame.id]=x to y;upsert(frame.copy(x=x,y=y))
        try { patchFrame(frame,obj("x" to x,"y" to y)) }
        catch(e:Exception) { pendingMoves.remove(frame.id);runCatching { board=Board.parse(client.json("/api/canvases/$id"));reconcile() };throw e }
        finally { pendingMoves.remove(frame.id) }
    }
    suspend fun deleteFrame(frame:Frame) = edit {
        val current=board?.frames?.find { it.id==frame.id } ?: error("This frame was deleted.")
        check(!current.locked) { "Unlock the frame before deleting it." }
        check(current.html==frame.html) { "This design changed. Select it again before deleting it." }
        client.data("/api/frames/${frame.id}","DELETE",obj("expectedUpdatedAt" to frame.updatedAt))
        record(Undo("delete",frame.id,current.body(),current.updatedAt))
        board=board?.copy(frames=board!!.frames.filter { it.id!=frame.id });select(null)
    }
    suspend fun undo() = edit {
        while(history.isNotEmpty()) {
            val e=history.last()
            try {
                when(e.type) {
                    "create"->{ client.data("/api/frames/${e.frameId}","DELETE",obj("expectedUpdatedAt" to e.expectedUpdatedAt));board=board?.copy(frames=board!!.frames.filter { it.id!=e.frameId }) }
                    "update"->{val frame=Frame.parse(client.json("/api/frames/${e.frameId}","PATCH",JSONObject(e.body.toString()).put("expectedUpdatedAt",e.expectedUpdatedAt)));upsert(frame);select(frame.id)
                        history=history.map { if(it.frameId==e.frameId) it.copy(expectedUpdatedAt=frame.updatedAt) else it }}
                    "delete"->{
                        val body=JSONObject(e.body.toString())
                        if(pages.none { it.id==body.string("pageId") }) body.put("pageId",pages.first().id)
                        val saved=try {client.json("/api/canvases/$id/frames","POST",body)} catch(ex:ApiException) {
                            if(ex.status!=400 || ex.message!="page not found") throw ex
                            body.remove("pageId");client.json("/api/canvases/$id/frames","POST",body)
                        }
                        val frame=Frame.parse(saved);upsert(frame)
                        history=history.map { if(it.frameId==e.frameId) it.copy(frameId=frame.id,expectedUpdatedAt=frame.updatedAt) else it };select(frame.id);viewportCommand++
                    }
                }
                history=history.dropLast(1);reconcile();viewportCommand++;break
            } catch(ex:ApiException) {
                if(ex.status==409) {
                    // A collaborator owns the newer version. Skip this frame's
                    // stale history so unrelated, older edits remain undoable.
                    history=history.filter { it.frameId!=e.frameId }
                    throw ex
                }
                if(ex.status!=404 || e.type=="delete") throw ex
                history=history.filter { it.frameId!=e.frameId || it.type=="delete" }
                board=board?.copy(frames=board!!.frames.filter { it.id!=e.frameId })
            }
        }
    }
    suspend fun queue(prompt:String,assignment:String?,references:List<String>,scoped:Boolean) {
        val body=obj("title" to (prompt.trim()+if(references.isEmpty()) "" else "\n\nReferenced canvas context:\n"+references.joinToString("\n")))
        assignment?.let { body.put("agents",org.json.JSONArray(listOf(it))) }
        if(scoped) selected?.let { f -> body.put("scope",obj("frameId" to f.id).apply { element?.takeIf { it.html==f.html }?.let { put("selector",it.selector) } }) }
        client.data("/api/canvases/$id/cards","POST",body)
    }
    suspend fun comment(text:String,frame:Frame?,selection:ElementSelection?) {
        val body=obj("text" to text.trim())
        val path=if(frame!=null) {
            check(selection==null || board?.frames?.find { it.id==frame.id }?.html==selection.html) { "This element changed. Select it again." }
            body.put("selector",selection?.selector ?: "body").put("snippet",selection?.text ?: "")
            "/api/frames/${frame.id}/comments"
        } else { body.put("pageId",activePage).put("x",0).put("y",0);"/api/canvases/$id/comments" }
        comments=items(comments,client.json(path,"POST",body))
    }
    suspend fun chooseModel(kind:String,value:String) {
        val selected=AccountModelSelection.parse(modelAccount)
        check(selected?.kind==kind && selected.options.any { it.optString("id")==value }) { "Your model account changed. Reopen the picker." }
        val path=client.server.url.newBuilder().addPathSegments("api/model-account").addPathSegment(kind).build().encodedPath
        modelAccount=client.json(path,"PATCH",obj("model" to value))
    }
}
