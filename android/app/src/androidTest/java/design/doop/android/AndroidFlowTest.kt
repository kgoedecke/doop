package design.doop.android

import android.content.Context
import android.content.Intent
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.espresso.Espresso
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.*
import okhttp3.*
import okhttp3.mockwebserver.*
import org.json.JSONArray
import org.json.JSONObject
import org.junit.*
import org.junit.Assert.*
import org.junit.runner.RunWith
import java.util.concurrent.CopyOnWriteArrayList

@RunWith(AndroidJUnit4::class)
class AndroidFlowTest {
    @get:Rule val compose=createEmptyComposeRule()
    private lateinit var server:MockWebServer
    private var scenario:ActivityScenario<MainActivity>?=null
    private val context get()=ApplicationProvider.getApplicationContext<Context>()
    private val frames=CopyOnWriteArrayList<JSONObject>()
    private val sockets=CopyOnWriteArrayList<WebSocket>()
    private val comments=CopyOnWriteArrayList<JSONObject>()
    private val tasks=CopyOnWriteArrayList<JSONObject>()
    private var created=false
    private var serial=0
    private var version=2000L
    private var chosenModel="fast"
    private fun accountView()=obj("accounts" to JSONArray(listOf(
        obj("kind" to "anthropic-key","enabled" to true,"model" to "other"),
        obj("kind" to "openai-key","enabled" to true,"model" to chosenModel))),
        "default" to "openai-key","menus" to obj("openai-key" to JSONArray(listOf(
            obj("id" to "fast","name" to "Fast model"),obj("id" to "careful","name" to "Careful model")))))
    private var queued:JSONObject?=null
    private val user=obj("id" to "test-user","name" to "Android Tester","email" to "android@example.test")
    private fun board()=obj("id" to "board","name" to "Android test canvas","frames" to JSONArray(frames.toList()),"pages" to JSONArray(listOf(obj("id" to "page-one","name" to "Page 1"),obj("id" to "page-two","name" to "Page 2"))))
    private fun broadcast(o:JSONObject) {sockets.forEach {it.send(o.toString())}}
    private fun response(value:Any)=MockResponse().setHeader("Content-Type","application/json").setBody(value.toString())
    @Before fun setup() {
        context.getSharedPreferences("settings",0).edit().clear().commit()
        context.getSharedPreferences("sessions",0).edit().clear().commit()
        server=MockWebServer()
        server.dispatcher=object:okhttp3.mockwebserver.Dispatcher() {
            override fun dispatch(request:RecordedRequest):MockResponse {
                val path=request.requestUrl!!.encodedPath
                val method=request.method
                android.util.Log.i("DoopFixture","$method $path")
                if(path=="/api/oidc-config") return response(obj("google" to true))
                if(path=="/api/auth/sign-in/email") return response(obj("user" to user)).setHeader("Set-Cookie","doop_test=session; Path=/; HttpOnly")
                if(path=="/api/auth/get-session") return response(if(request.getHeader("Cookie")?.contains("doop_test=session")==true) obj("user" to user) else "null")
                if(request.getHeader("Cookie")?.contains("doop_test=session")!=true) return response(obj("error" to "unauthorized")).setResponseCode(401)
                if(path=="/api/workspaces") return response(obj("workspaces" to JSONArray()))
                if(path=="/api/model-account" && method=="GET") return response(accountView())
                if(path=="/api/model-account/openai-key" && method=="PATCH") {
                    chosenModel=JSONObject(request.body.readUtf8()).getString("model")
                    return response(accountView())
                }
                if(path=="/api/canvases") {
                    if(method=="POST") {created=true;return response(board())}
                    return response(JSONArray(if(created) listOf(obj("id" to "board","name" to "Android test canvas","updatedAt" to 1,"frameCount" to frames.size)) else emptyList()))
                }
                if(path=="/api/canvases/board") return response(board())
                if(path=="/api/canvases/board/frames" && method=="POST") {
                    val frame=JSONObject(request.body.readUtf8()).put("id","frame-${++serial}").put("canvasId","board").put("updatedAt",++version)
                    if(!frame.has("z")) frame.put("z",version)
                    frames.add(frame);broadcast(obj("type" to "frame:created","frame" to frame));return response(frame)
                }
                if(path.startsWith("/api/frames/") && !path.endsWith("/comments")) {
                    val id=path.substringAfterLast('/');val frame=frames.find {it.getString("id")==id} ?: return MockResponse().setResponseCode(404)
                    val patch=JSONObject(request.body.readUtf8())
                    if(!patch.has("expectedUpdatedAt")) return response(obj("error" to "expectedUpdatedAt required")).setResponseCode(400)
                    if(patch.getLong("expectedUpdatedAt")!=frame.optLong("updatedAt"))
                        return response(obj("error" to "The frame changed while you were editing. Please try again.","frame" to frame)).setResponseCode(409)
                    if(method=="DELETE") {frames.remove(frame);broadcast(obj("type" to "frame:deleted","frameId" to id));return response(obj("ok" to true))}
                    patch.remove("expectedUpdatedAt");patch.keys().forEach {frame.put(it,patch.get(it))};frame.put("updatedAt",++version)
                    broadcast(obj("type" to "frame:updated","frame" to frame));return response(frame)
                }
                if(path.endsWith("/comments") && method=="POST") {
                    val body=JSONObject(request.body.readUtf8())
                    val comment=body.put("id","comment-${comments.size}").put("from","Android Tester").put("at",System.currentTimeMillis())
                    if(path.startsWith("/api/frames/")) comment.put("frameId",path.split('/')[3])
                    comments.add(comment);broadcast(obj("type" to "comment","comment" to comment));return response(comment)
                }
                if(path=="/api/canvases/board/cards") {
                    queued=JSONObject(request.body.readUtf8())
                    val task=obj("id" to "task","agentName" to "Doop","status" to "working","startedAt" to System.currentTimeMillis())
                    tasks.add(task);broadcast(obj("type" to "task","task" to task));return response(obj("id" to "card"))
                }
                if(path=="/ws") return MockResponse().withWebSocketUpgrade(object:WebSocketListener() {
                    override fun onOpen(webSocket:WebSocket,response:Response) {sockets.add(webSocket)}
                    override fun onMessage(webSocket:WebSocket,text:String) {
                        if(JSONObject(text).optString("type")=="join") webSocket.send(obj("type" to "init","canvas" to board(),"tasks" to JSONArray(tasks.toList()),"comments" to JSONArray(comments.toList()),"presences" to JSONArray()).toString())
                    }
                })
                return response(obj("error" to "unhandled $method $path")).setResponseCode(404)
            }
        }
        server.start()
        context.getSharedPreferences("settings",0).edit().putString("server",server.url("/").toString()).commit()
    }
    @After fun teardown() {
        context.stopService(Intent(context,AgentFollowService::class.java))
        scenario?.close();sockets.forEach {it.close(1000,null)};server.shutdown()
    }
    private fun awaitText(text:String) {
        try {compose.waitUntil(20000) {compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty()}}
        catch(e:Throwable) {
            compose.onRoot().printToLog("DoopUiTest")
            androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()?.let { bitmap ->
                java.io.File(context.cacheDir,"android-failure.png").outputStream().use {bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it)}
                bitmap.recycle()
            }
            throw e
        }
    }
    @Test fun signInCreateEditUndoCommentAndPromptOverAuthenticatedWebSocket() {
        scenario=ActivityScenario.launch(Intent(context,MainActivity::class.java))
        awaitText("Email")
        compose.onNodeWithText("Email").performTextInput("android@example.test")
        compose.onNodeWithText("Password").performTextInput("fixture-password")
        Espresso.closeSoftKeyboard()
        compose.onNodeWithText("Sign in").performScrollTo().assertIsEnabled().performClick()
        awaitText("New canvas")
        compose.onNodeWithText("New canvas").performClick()
        compose.onNodeWithText("Canvas name").performTextInput("Android test canvas")
        compose.onNodeWithText("Save").performClick()
        compose.waitUntil(20000) {compose.onAllNodesWithText("Live · 1 present").fetchSemanticsNodes().isNotEmpty()}
        awaitText("Fast model")
        compose.onNodeWithText("Fast model").performClick()
        compose.onNodeWithText("Careful model").performClick()
        compose.waitUntil(10000) {chosenModel=="careful"}
        awaitText("Careful model")
        compose.onNodeWithContentDescription("Add frame").performClick()
        compose.waitUntil(15000) {frames.size==1}
        compose.onNodeWithContentDescription("Frame properties").performClick()
        awaitText("Frame HTML")
        compose.onNodeWithText("Name").performTextReplacement("First Android frame")
        compose.onNodeWithText("Frame HTML").performTextReplacement("<body style='margin:0;background:#ff0000'><h1>Hello Android</h1></body>")
        Espresso.closeSoftKeyboard()
        compose.onNodeWithText("Save changes").performScrollTo().performClick()
        compose.waitUntil(15000) {frames.first().optString("name")=="First Android frame"}
        compose.onNodeWithContentDescription("Duplicate selection").performClick()
        compose.waitUntil(15000) {frames.size==2}
        compose.onNodeWithContentDescription("Undo").performClick()
        compose.waitUntil(15000) {frames.size==1}
        compose.onNodeWithContentDescription("Comment").performClick()
        awaitText("Write a comment")
        compose.onNodeWithText("Write a comment").performTextInput("Android comment")
        Espresso.closeSoftKeyboard()
        compose.onNodeWithText("Post comment").performClick()
        awaitText("Android comment")
        compose.waitUntil(10000) {comments.size==1}
        Espresso.pressBack()
        compose.onNodeWithContentDescription("Prompt").performTextInput("Make a friendly landing page")
        Espresso.closeSoftKeyboard()
        compose.onNodeWithContentDescription("Send prompt").performClick()
        compose.waitUntil(10000) {queued!=null}
        assertEquals("Make a friendly landing page",queued!!.getString("title"))
        compose.waitUntil(10000) {compose.onAllNodesWithText("Make a friendly landing page").fetchSemanticsNodes().isEmpty()}
        androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()?.let { bitmap ->
            java.io.File(context.cacheDir,"android-canvas.png").outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it) }
            bitmap.recycle()
        }
        // The session cookie survives a new client, and remains unavailable to another server.
        runBlocking {
            val restored=DoopClient(context,ServerAddress.parse(server.url("/").toString(),true))
            assertEquals("test-user",restored.json("/api/auth/get-session").getJSONObject("user").getString("id"))
            assertTrue(restored.cookies.loadForRequest(ServerAddress.parse("https://example.com").url).isEmpty())
            assertTrue(restored.cookies.loadForRequest(server.url("/").newBuilder().port(server.port+1).build()).isEmpty())
            restored.close()
        }
    }

    @Test fun livePagesReconnectAndStaleSelectionsStayConsistent()=runBlocking {
        created=true
        val f=obj("id" to "f","canvasId" to "board","name" to "Frame","width" to 200,"height" to 300,"x" to 0,"y" to 0,"html" to "<body>Before</body>")
        frames.add(f)
        val client=DoopClient(context,ServerAddress.parse(server.url("/").toString(),true))
        client.data("/api/auth/sign-in/email","POST",obj("email" to "android@example.test","password" to "fixture"))
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.Main.immediate)
        val model=withContext(Dispatchers.Main) {CanvasModel("board",client,"Test",scope).also {it.start()}}
        suspend fun await(predicate:()->Boolean)=withTimeout(15000) {withContext(Dispatchers.Main) {while(!predicate()) delay(25)}}
        try {
            await {model.connected}
            withContext(Dispatchers.Main) {
                assertEquals("page-one",model.activePage)
                model.select("f")
                model.element=ElementSelection("f",f.getString("html"),"body","body","",0f,0f,200f,300f)
            }
            f.put("html","<body>Changed remotely</body>")
            broadcast(obj("type" to "frame:updated","frame" to f))
            await {model.element==null && model.selected?.html==f.getString("html")}
            broadcast(obj("type" to "canvas:pages","pages" to JSONArray(listOf(obj("id" to "page-two","name" to "Page 2"),obj("id" to "page-one","name" to "Page 1")))))
            await {model.pages.first().id=="page-two"}
            withContext(Dispatchers.Main) {assertEquals("page-one",model.board!!.pageOf(model.board!!.frames.first()));model.selectPage("page-two")}
            sockets.last().close(1011,"retry fixture")
            await {sockets.size>=2 && model.connected}
            withContext(Dispatchers.Main) {
                assertEquals("page-two",model.activePage)
                model.stop();model.start()
            }
            await {sockets.size>=3 && model.connected}
            broadcast(obj("type" to "canvas:pages","pages" to JSONArray(listOf(obj("id" to "page-one","name" to "Page 1")))))
            await {model.activePage=="page-one"}
        } finally {withContext(Dispatchers.Main) {model.dispose()};scope.cancel();client.close()}
    }

    @Test fun versionedEditsAndUndoPreserveRemoteChangesAndLayout()=runBlocking {
        val f=obj("id" to "f","canvasId" to "board","name" to "Rotated frame","width" to 200,"height" to 300,
            "x" to 0,"y" to 0,"html" to "Before","updatedAt" to 1234,"z" to 42.5,"rotation" to -33.5,"pageId" to "page-one")
        frames.add(f)
        val client=DoopClient(context,ServerAddress.parse(server.url("/").toString(),true))
        client.data("/api/auth/sign-in/email","POST",obj("email" to "android@example.test","password" to "fixture"))
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.Main.immediate)
        val model=withContext(Dispatchers.Main) {CanvasModel("board",client,"Test",scope).also {it.start()}}
        try {withContext(Dispatchers.Main) {
            withTimeout(15000) {while(!model.connected) delay(25)}
            model.select("f")
            val stale=model.selected!!
            // Do not deliver a WebSocket event: the write must detect the server race.
            f.put("html","Collaborator HTML").put("updatedAt",++version)
            val conflict=runCatching {model.patchFrame(stale,obj("html" to "Stale overwrite"))}.exceptionOrNull()
            assertEquals(409,(conflict as ApiException).status)
            assertEquals("Collaborator HTML",frames.first().getString("html"))
            assertEquals("Collaborator HTML",model.selected!!.html)
            assertFalse(model.canUndo)

            model.patchFrame(model.selected!!,obj("html" to "Local first"))
            model.patchFrame(model.selected!!,obj("html" to "Local second"))
            model.undo();assertEquals("Local first",model.selected!!.html)
            model.undo();assertEquals("Collaborator HTML",model.selected!!.html)

            val beforeDelete=model.selected!!
            f.put("name","Remote name").put("updatedAt",++version)
            assertEquals(409,(runCatching {model.deleteFrame(beforeDelete)}.exceptionOrNull() as ApiException).status)
            assertEquals(1,frames.size)
            model.deleteFrame(model.selected!!)
            assertTrue(frames.isEmpty())
            model.undo()
            assertEquals(1,frames.size)
            assertEquals(42.5,frames.first().getDouble("z"),0.0)
            assertEquals(-33.5,frames.first().getDouble("rotation"),0.0)
            assertEquals("Remote name",model.selected!!.name)
            assertEquals("page-one",model.selected!!.pageId)

            val restoredId=model.selected!!.id
            model.addFrame()
            val unrelatedId=model.selected!!.id
            val unrelatedName=model.selected!!.name
            model.patchFrame(model.selected!!,obj("name" to "Unrelated edit"))
            model.select(restoredId)
            model.patchFrame(model.selected!!,obj("html" to "Local third"))
            frames.first {it.getString("id")==restoredId}.put("html","New collaborator HTML").put("updatedAt",++version)
            assertEquals(409,(runCatching {model.undo()}.exceptionOrNull() as ApiException).status)
            assertEquals("New collaborator HTML",model.selected!!.html)
            assertTrue(model.canUndo)
            model.undo()
            assertEquals(unrelatedId,model.selected!!.id)
            assertEquals(unrelatedName,model.selected!!.name)
            model.undo()
            assertEquals(1,frames.size)
            assertEquals("New collaborator HTML",frames.first().getString("html"))
            assertFalse(model.canUndo)
        }} finally {withContext(Dispatchers.Main) {model.dispose()};scope.cancel();client.close()}
    }

    @Test fun isolatedElementEditorKeepsScriptsInertAndRemapsDuplicateIds()=runBlocking {
        val f=Frame("f","c","Frame",0f,0f,200f,200f,"<html><body><script>document.body.innerHTML='EXECUTED'</script><div id='card'><label for='input'>Name</label><input id='input'></div></body></html>")
        val e=ElementSelection(f.id,f.html,"#card","div#card","",0f,0f,100f,100f)
        val copy=SelectionActions.edit(context,f,e,"copy")
        assertTrue(copy.contains("id=\"card\""));assertFalse(copy.contains("EXECUTED"))
        val duplicate=SelectionActions.edit(context,f,e,"duplicate")
        assertTrue(duplicate.contains("id=\"card-copy\""));assertTrue(duplicate.contains("for=\"input-copy\""))
        val locked=f.copy(html="<body><div data-doop-locked id='card'>Locked</div></body>")
        val lockedSelection=e.copy(html=locked.html)
        assertTrue(runCatching {SelectionActions.edit(context,locked,lockedSelection,"delete")}.isFailure)
    }

    @Test fun pngExportProducesReadableContentUriWithTemporaryPermission()=runBlocking {
        var shared:Intent?=null
        val exportContext=object:android.content.ContextWrapper(context) {override fun startActivity(intent:Intent) {shared=intent}}
        val client=DoopClient(context,ServerAddress.parse(server.url("/").toString(),true))
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.Main)
        val model=CanvasModel("board",client,"Test",scope)
        val frame=Frame("f","board","Export",0f,0f,100f,100f,"<body style='margin:0;width:100px;height:100px;background:#00ff00'></body>")
        try {
            withContext(Dispatchers.Main) {SelectionActions.export(exportContext,model,frame,null,true)}
            @Suppress("DEPRECATION") val send=shared!!.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)!!
            @Suppress("DEPRECATION") val uri=send.getParcelableExtra<android.net.Uri>(Intent.EXTRA_STREAM)!!
            assertEquals("content",uri.scheme)
            assertTrue(send.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0)
            val bitmap=context.contentResolver.openInputStream(uri).use {android.graphics.BitmapFactory.decodeStream(it)}!!
            assertEquals(200,bitmap.width);assertEquals(android.graphics.Color.GREEN,bitmap.getPixel(100,100));bitmap.recycle()
        } finally {withContext(Dispatchers.Main) {model.dispose()};scope.cancel();client.close()}
    }

    @Test fun backgroundFollowingStartsAndStopsWithVisibleNotification() {
        runBlocking {
            val client=DoopClient(context,ServerAddress.parse(server.url("/").toString(),true))
            client.data("/api/auth/sign-in/email","POST",obj("email" to "android@example.test","password" to "fixture"));client.close()
        }
        if(android.os.Build.VERSION.SDK_INT>=33) androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().uiAutomation.grantRuntimePermission(context.packageName,android.Manifest.permission.POST_NOTIFICATIONS)
        scenario=ActivityScenario.launch(Intent(context,MainActivity::class.java))
        awaitText("New canvas")
        compose.onNodeWithContentDescription("Settings").performClick()
        awaitText("Follow working agents")
        compose.onNode(isToggleable()).performClick()
        val manager=context.getSystemService(android.app.NotificationManager::class.java)
        compose.waitUntil(15000) {manager.activeNotifications.any {it.id==410}}
        compose.onNode(isToggleable()).performClick()
        compose.waitUntil(15000) {manager.activeNotifications.none {it.id==410}}
    }
}
