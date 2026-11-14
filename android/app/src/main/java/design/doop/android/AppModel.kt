package design.doop.android

import android.app.Application
import android.net.Uri
import androidx.compose.runtime.*
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.*
import org.json.JSONObject

class AppModel(application: Application): AndroidViewModel(application) {
    private val prefs = application.getSharedPreferences("settings",0)
    var client by mutableStateOf(DoopClient(application, ServerAddress.parse(prefs.getString("server","https://doop.design")!!, BuildConfig.DEBUG)))
        private set
    var user by mutableStateOf<JSONObject?>(null)
    var canvases by mutableStateOf<List<JSONObject>>(emptyList())
    var workspaces by mutableStateOf<List<JSONObject>>(emptyList())
    var providers by mutableStateOf(JSONObject())
    var loading by mutableStateOf(true)
    var error by mutableStateOf<String?>(null)
    var board by mutableStateOf<CanvasModel?>(null)
    var settings by mutableStateOf(false)
    var foreground = true
    var followAgents by mutableStateOf(prefs.getBoolean("followAgents",false))
        private set

    init { restore() }
    fun action(block: suspend () -> Unit) { viewModelScope.launch {
        try { block() } catch(e: CancellationException) { throw e } catch(e: Exception) { error = e.message ?: "Something went wrong. Try again." }
    } }
    fun restore() = action { restoreNow() }
    suspend fun restoreNow() {
        val current=client;loading=true;error=null
        try {
            val session = current.data("/api/auth/get-session")
            val result=if (session.isBlank() || session == "null") null else JSONObject(session).optJSONObject("user")
            if (current !== client) return
            user=result
            if (user != null) reload()
        } finally { if (current === client) loading=false }
        val config=runCatching { current.json("/api/oidc-config") }.getOrDefault(JSONObject())
        if (current === client) providers=config
    }
    suspend fun reload() {
        val current=client
        try {
            val (items,spaces) = coroutineScope {
                val a=async { current.list("/api/canvases") }
                val b=async { current.json("/api/workspaces").objects("workspaces") }
                a.await() to b.await()
            }
            if(current === client) { canvases=items.sortedByDescending { it.optLong("updatedAt") };workspaces=spaces }
        } catch(e:ApiException) {
            if(e.status==401 && current===client) { user=null;canvases=emptyList();workspaces=emptyList() }
            throw e
        }
    }
    suspend fun signIn(email:String,password:String,name:String?) {
        val body=obj("email" to email.trim(),"password" to password).apply { name?.let { put("name",it.trim()) } }
        client.data(if(name==null) "/api/auth/sign-in/email" else "/api/auth/sign-up/email","POST",body)
        restoreNow()
        if(user==null) error("Check your email to verify your account, then sign in.")
    }
    fun providerUrl(provider:String): Uri {
        val attempt=AuthAttempt.create(client.server.origin)
        prefs.edit().putString("authChallenge",attempt.challenge).putString("authOrigin",attempt.origin).putLong("authStarted",attempt.started).commit()
        return Uri.parse(attempt.origin+"/desktop/signin").buildUpon().appendQueryParameter("provider",provider).appendQueryParameter("challenge",attempt.challenge).build()
    }
    fun handleAuth(uri:Uri) = action {
        val challenge=prefs.getString("authChallenge",null) ?: return@action
        val attempt=AuthAttempt(challenge,prefs.getString("authOrigin","")!!,prefs.getLong("authStarted",0))
        val token=attempt.token(java.net.URI(uri.toString())) ?: error("This sign-in link has expired or does not match your request. Try again.")
        require(attempt.origin==client.server.origin) { "The sign-in server changed. Try again." }
        prefs.edit().remove("authChallenge").remove("authOrigin").remove("authStarted").commit()
        client.data("/api/auth/one-time-token/verify","POST",obj("token" to token))
        restoreNow()
    }
    suspend fun changeServer(text:String) {
        val address=ServerAddress.parse(text,BuildConfig.DEBUG)
        closeBoard();client.close();updateFollowAgents(false)
        client=DoopClient(getApplication(),address)
        prefs.edit().putString("server",address.origin).remove("authChallenge").apply()
        user=null;canvases=emptyList();workspaces=emptyList();providers=JSONObject();settings=false
        restoreNow()
    }
    suspend fun signOut() {
        client.data("/api/auth/sign-out","POST")
        clearSession()
    }
    private fun clearSession() {
        closeBoard();updateFollowAgents(false);client.cookies.clear();client.close()
        client=DoopClient(getApplication(),client.server)
        user=null;canvases=emptyList();workspaces=emptyList();settings=false
    }
    suspend fun hasPassword()=client.list("/api/auth/list-accounts").any { it.optString("providerId")=="credential" }
    suspend fun deleteAccount(password:String?) {
        client.data("/api/auth/delete-user","POST",JSONObject().apply { password?.let { put("password",it) } })
        clearSession()
    }
    suspend fun createCanvas(name:String,workspaceId:String?) {
        val result=client.json("/api/canvases","POST",obj("name" to name.trim().ifBlank { "Untitled canvas" }).apply { workspaceId?.let { put("workspaceId",it) } })
        reload();openBoard(result.getString("id"))
    }
    fun openBoard(id:String) {
        board?.dispose()
        board=CanvasModel(id,client,user?.optString("name") ?: "Android",viewModelScope).also { it.start() }
    }
    fun closeBoard() { board?.dispose();board=null }
    fun updateForeground(value:Boolean) {
        foreground=value
        if(value) {followAgents=prefs.getBoolean("followAgents",false);board?.start()} else board?.stop()
    }
    fun updateFollowAgents(value:Boolean) {
        followAgents=value;prefs.edit().putBoolean("followAgents",value).apply()
        AgentFollowService.setEnabled(getApplication(),value)
    }
    override fun onCleared() { board?.dispose();client.close() }
}
