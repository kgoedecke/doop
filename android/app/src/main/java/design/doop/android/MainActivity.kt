package design.doop.android

import android.Manifest
import android.content.Intent
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.*
import androidx.compose.ui.text.input.*
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.*
import org.json.JSONObject

class MainActivity:ComponentActivity() {
    private val app:AppModel by viewModels()
    private val notifications=registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted -> if(granted) app.updateFollowAgents(true) }
    fun followAgents() {
        if(Build.VERSION.SDK_INT>=33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=android.content.pm.PackageManager.PERMISSION_GRANTED)
            notifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        else app.updateFollowAgents(true)
    }
    override fun onCreate(savedInstanceState:Bundle?) {
        super.onCreate(savedInstanceState);enableEdgeToEdge()
        if(savedInstanceState==null) handle(intent)
        setContent { DoopTheme { DoopApp(app) } }
    }
    override fun onNewIntent(intent:Intent) { super.onNewIntent(intent);setIntent(intent);handle(intent) }
    private fun handle(intent:Intent) {
        intent.data?.let { if(it.scheme=="doop" && it.host=="auth") app.handleAuth(it) }
        intent.getStringExtra("canvasId")?.let { app.openBoard(it) }
    }
    override fun onStart() { super.onStart();app.updateForeground(true) }
    override fun onStop() { app.updateForeground(false);super.onStop() }
}

@Composable fun DoopApp(app:AppModel) {
    Surface(Modifier.fillMaxSize(),color=MaterialTheme.colorScheme.background) {
        when {
            app.settings->SettingsScreen(app)
            app.board!=null->CanvasScreen(app,app.board!!)
            app.loading->Column(Modifier.fillMaxSize(),horizontalAlignment=Alignment.CenterHorizontally,verticalArrangement=Arrangement.Center) { Wordmark();Spacer(Modifier.height(24.dp));CircularProgressIndicator(Modifier.size(20.dp),strokeWidth=2.dp) }
            app.user==null->SignInScreen(app)
            else->LibraryScreen(app)
        }
        app.error?.let { message -> AlertDialog(onDismissRequest={app.error=null},title={Text("Couldn’t finish")},text={Text(message)},confirmButton={TextButton(onClick={app.error=null}) {Text("OK")} }) }
    }
}
fun openBrowser(context:android.content.Context,url:String) { CustomTabsIntent.Builder().build().launchUrl(context,Uri.parse(url)) }

@Composable private fun SignInScreen(app:AppModel) {
    var email by rememberSaveable { mutableStateOf("") };var password by remember { mutableStateOf("") };var name by rememberSaveable { mutableStateOf("") }
    var register by rememberSaveable { mutableStateOf(false) };var busy by remember { mutableStateOf(false) }
    val context=LocalContext.current
    val providers=listOf("google" to "Google","microsoft" to "Microsoft","apple" to "Apple","oidc" to (app.providers.string("displayName") ?: "SSO"))
        .filter {app.providers.optBoolean(if(it.first=="oidc") "enabled" else it.first)}
    Column(Modifier.fillMaxSize().safeDrawingPadding().imePadding().verticalScroll(rememberScrollState()).padding(horizontal=28.dp),horizontalAlignment=Alignment.CenterHorizontally) {
        Column(Modifier.widthIn(max=424.dp).fillMaxWidth()) {
            Row(Modifier.fillMaxWidth().padding(top=16.dp),verticalAlignment=Alignment.CenterVertically) {
                Wordmark();Spacer(Modifier.weight(1f));Tool("Server settings",DoopIcons.Settings) {app.settings=true}
            }
            Spacer(Modifier.height(42.dp))
            Text(if(register) "Make room for\nyour next idea." else "Your ideas.\nAnywhere.",fontFamily=Inter,fontWeight=FontWeight.Medium,fontSize=40.sp,lineHeight=44.sp,letterSpacing=(-1).sp)
            Text("A shared design space for you, your team, and your agents.",style=MaterialTheme.typography.bodyLarge,color=MaterialTheme.colorScheme.onSurfaceVariant,modifier=Modifier.padding(top=14.dp,bottom=28.dp))
            Column(verticalArrangement=Arrangement.spacedBy(10.dp)) {
                providers.forEach { (id,label) ->
                    OutlinedButton(onClick={openBrowser(context,app.providerUrl(id).toString())},enabled=!busy,
                        shape=RoundedCornerShape(10.dp),border=BorderStroke(1.dp,MaterialTheme.colorScheme.outline),modifier=Modifier.fillMaxWidth().height(50.dp)) {
                        when(id) {
                            "google"->Image(painterResource(R.drawable.google_mark),null,Modifier.size(18.dp))
                            "microsoft"->Image(painterResource(R.drawable.microsoft_mark),null,Modifier.size(18.dp))
                            "apple"->Icon(painterResource(R.drawable.apple_mark),null,Modifier.size(18.dp))
                            else->Icon(DoopIcons.Key,null,Modifier.size(18.dp))
                        }
                        Spacer(Modifier.width(10.dp));Text("Continue with $label",fontWeight=FontWeight.SemiBold)
                    }
                }
            }
            if(providers.isNotEmpty()) Row(Modifier.padding(vertical=22.dp),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(14.dp)) {
                HorizontalDivider(Modifier.weight(1f));Text("or",style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant);HorizontalDivider(Modifier.weight(1f))
            }
            Column(verticalArrangement=Arrangement.spacedBy(12.dp)) {
                if(register) OutlinedTextField(name,{name=it},label={Text("Name")},singleLine=true,shape=RoundedCornerShape(10.dp),modifier=Modifier.fillMaxWidth())
                OutlinedTextField(email,{email=it},label={Text("Email")},keyboardOptions=KeyboardOptions(keyboardType=KeyboardType.Email),singleLine=true,shape=RoundedCornerShape(10.dp),modifier=Modifier.fillMaxWidth())
                OutlinedTextField(password,{password=it},label={Text("Password")},visualTransformation=PasswordVisualTransformation(),keyboardOptions=KeyboardOptions(keyboardType=KeyboardType.Password),singleLine=true,shape=RoundedCornerShape(10.dp),modifier=Modifier.fillMaxWidth())
                Button(onClick={busy=true;app.action {
                    try {app.signIn(email,password,if(register) name else null);password=""} finally {busy=false}
                }},enabled=!busy && email.isNotBlank() && password.isNotBlank() && (!register || name.isNotBlank()),
                    shape=RoundedCornerShape(10.dp),modifier=Modifier.fillMaxWidth().padding(top=6.dp).height(50.dp)) {
                    Text(if(busy) "Signing in…" else if(register) "Create account" else "Sign in",fontWeight=FontWeight.SemiBold)
                }
                TextButton(onClick={register=!register},modifier=Modifier.fillMaxWidth()) {Text(if(register) "Already have an account? Sign in" else "New to Doop? Create an account",fontSize=12.sp)}
            }
            Text(app.client.server.url.host,fontSize=11.sp,color=MaterialTheme.colorScheme.onSurfaceVariant,modifier=Modifier.padding(top=16.dp,bottom=28.dp))
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable private fun LibraryScreen(app:AppModel) {
    var search by rememberSaveable {mutableStateOf("")};var workspace by rememberSaveable {mutableStateOf<String?>(null)}
    var newCanvas by remember {mutableStateOf(false)};var rename by remember {mutableStateOf<JSONObject?>(null)};var deleting by remember {mutableStateOf<JSONObject?>(null)}
    var workspaceMenu by remember {mutableStateOf(false)};var working by remember {mutableStateOf(false)}
    val context=LocalContext.current
    val visible=app.canvases.filter { it.optString("name").contains(search,true) && (workspace==null || it.string("workspaceId")==workspace) }
    Scaffold(containerColor=MaterialTheme.colorScheme.background,topBar={
        TopAppBar(title={Wordmark()},actions={
            Tool("Working agents",DoopIcons.AutoAwesome) {working=true}
            Tool("Refresh library",DoopIcons.Refresh) {app.action {app.reload()}}
            Tool("Settings",DoopIcons.Settings) {app.settings=true}
        })
    },floatingActionButton={ExtendedFloatingActionButton(onClick={newCanvas=true},shape=RoundedCornerShape(12.dp),containerColor=MaterialTheme.colorScheme.primary,contentColor=MaterialTheme.colorScheme.onPrimary) { Icon(DoopIcons.Add,null);Spacer(Modifier.width(12.dp));Text("New canvas") }}) { padding ->
        LazyVerticalGrid(columns=GridCells.Adaptive(280.dp),modifier=Modifier.padding(padding).fillMaxSize(),contentPadding=PaddingValues(start=20.dp,end=20.dp,bottom=100.dp),verticalArrangement=Arrangement.spacedBy(16.dp),horizontalArrangement=Arrangement.spacedBy(16.dp)) {
            item(span={GridItemSpan(maxLineSpan)}) {Column {
                Text("What’s next, ${app.user?.optString("name")?.substringBefore(' ') ?: "designer"}?",fontSize=34.sp,fontFamily=Hanken,fontWeight=FontWeight.Light,modifier=Modifier.padding(top=22.dp,bottom=6.dp))
                Text("Pick up an idea. Or start something new.",color=MaterialTheme.colorScheme.onSurfaceVariant)
                OutlinedTextField(search,{search=it},placeholder={Text("Search canvases")},leadingIcon={Icon(DoopIcons.Search,null)},singleLine=true,shape=RoundedCornerShape(10.dp),modifier=Modifier.fillMaxWidth().padding(top=24.dp))
                Box { TextButton(onClick={workspaceMenu=true}) {Text(app.workspaces.find {it.optString("id")==workspace}?.optString("name") ?: "All workspaces");Icon(DoopIcons.ExpandMore,null)}
                    DropdownMenu(expanded=workspaceMenu,onDismissRequest={workspaceMenu=false}) {
                        DropdownMenuItem(text={Text("All workspaces")},onClick={workspace=null;workspaceMenu=false})
                        app.workspaces.forEach { w -> DropdownMenuItem(text={Text(w.optString("name"))},onClick={workspace=w.getString("id");workspaceMenu=false}) }
                    }
                }
            } }
            if(visible.isEmpty()) item(span={GridItemSpan(maxLineSpan)}) { Column(Modifier.fillMaxWidth().padding(vertical=60.dp),horizontalAlignment=Alignment.CenterHorizontally) {
                DoopLogo(42)
                Text(if(search.isBlank()) "Your next idea starts here." else "No canvases found",modifier=Modifier.padding(12.dp),style=MaterialTheme.typography.titleLarge)
                Text(if(search.isBlank()) "Create a canvas and make something together." else "Try another name.",color=MaterialTheme.colorScheme.onSurfaceVariant)
            } }
            items(visible,key={it.getString("id")}) { canvas ->
                var menu by remember {mutableStateOf(false)}
                Card(onClick={app.openBoard(canvas.getString("id"))},shape=RoundedCornerShape(12.dp),border=BorderStroke(1.dp,MaterialTheme.colorScheme.outlineVariant),colors=CardDefaults.cardColors(containerColor=MaterialTheme.colorScheme.surface)) {
                    CanvasPreview(app.client,canvas.string("previewFrameId"),Modifier.fillMaxWidth().height(175.dp))
                    Row(Modifier.padding(start=18.dp,end=6.dp,top=12.dp,bottom=16.dp),verticalAlignment=Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(canvas.optString("name","Untitled canvas"),fontWeight=FontWeight.SemiBold,maxLines=2,overflow=TextOverflow.Ellipsis)
                            Text("${canvas.optInt("frameCount")} frames"+(if(canvas.optBoolean("shared")) " · Shared with you" else ""),style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant,modifier=Modifier.padding(top=6.dp))
                        }
                        Box { Tool("Canvas actions",DoopIcons.MoreVert) {menu=true}
                            DropdownMenu(menu,{menu=false}) {
                                DropdownMenuItem(text={Text("Rename")},onClick={menu=false;rename=canvas})
                                DropdownMenuItem(text={Text("Duplicate")},onClick={menu=false;app.action {app.client.data("/api/canvases/${canvas.getString("id")}/duplicate","POST");app.reload()}})
                                DropdownMenuItem(text={Text("Share link")},onClick={menu=false;SelectionActions.shareText(context,app.client.server.origin+"/c/"+canvas.getString("id"))})
                                DropdownMenuItem(text={Text("Delete")},onClick={menu=false;deleting=canvas})
                            }
                        }
                    }
                }
            }
        }
    }
    if(newCanvas) TextEntryDialog("New canvas","Canvas name","",{newCanvas=false}) { app.createCanvas(it,workspace);newCanvas=false }
    rename?.let { c -> TextEntryDialog("Rename canvas","Canvas name",c.optString("name"),{rename=null}) {app.client.data("/api/canvases/${c.getString("id")}","PATCH",obj("name" to it));app.reload();rename=null} }
    deleting?.let { c -> ConfirmDialog("Delete ${c.optString("name")}?","This deletes the canvas and its frames for everyone.",{deleting=null}) {app.client.data("/api/canvases/${c.getString("id")}","DELETE");app.reload();deleting=null} }
    if(working) ModalBottomSheet(onDismissRequest={working=false}) {Column(Modifier.padding(24.dp).verticalScroll(rememberScrollState())) {
        Text("Working agents",style=MaterialTheme.typography.headlineSmall)
        val active=app.canvases.filter { it.objects("activeTasks").isNotEmpty() }
        if(active.isEmpty()) Text("No agents are working right now.",Modifier.padding(vertical=24.dp))
        active.forEach { c -> ListItem(headlineContent={Text(c.optString("name"))},supportingContent={Text(c.objects("activeTasks").joinToString {it.optString("agentName")})},modifier=Modifier.clickable {working=false;app.openBoard(c.getString("id"))}) }
    } }
}

@Composable private fun CanvasPreview(client:DoopClient,id:String?,modifier:Modifier) {
    val image by produceState<android.graphics.Bitmap?>(null,id,client) {
        if(id!=null) value=withContext(Dispatchers.IO) {runCatching {client.http.newCall(client.request("/i/$id.jpg?preview=")).execute().use { r -> if(r.isSuccessful) r.body?.byteStream()?.use {BitmapFactory.decodeStream(it,null,BitmapFactory.Options().apply {inSampleSize=2})} else null }}.getOrNull()}
    }
    Box(modifier.background(MaterialTheme.colorScheme.surfaceContainer),contentAlignment=Alignment.Center) {
        image?.let {Image(it.asImageBitmap(),null,Modifier.fillMaxSize(),contentScale=ContentScale.Crop)} ?: Icon(DoopIcons.Layers,null,Modifier.size(40.dp),tint=MaterialTheme.colorScheme.outline)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable private fun SettingsScreen(app:AppModel) {
    BackHandler {app.settings=false}
    val context=LocalContext.current
    var server by rememberSaveable {mutableStateOf(app.client.server.origin)};var delete by remember {mutableStateOf(false)};var passwordRequired by remember {mutableStateOf(false)}
    var password by remember {mutableStateOf("")}
    Scaffold(topBar={TopAppBar(title={Text("Settings")},navigationIcon={Tool("Back",DoopIcons.ArrowBack) {app.settings=false}})}) {padding ->
        Column(Modifier.padding(padding).verticalScroll(rememberScrollState()).padding(24.dp),verticalArrangement=Arrangement.spacedBy(18.dp)) {
            app.user?.let {Text(it.optString("name"),style=MaterialTheme.typography.headlineSmall);Text(it.optString("email"),color=MaterialTheme.colorScheme.onSurfaceVariant)}
            Text("Server",fontWeight=FontWeight.SemiBold)
            OutlinedTextField(server,{server=it},label={Text("Server address")},singleLine=true,modifier=Modifier.fillMaxWidth(),keyboardOptions=KeyboardOptions(keyboardType=KeyboardType.Uri))
            Button(onClick={app.action {app.changeServer(server)}},enabled=server.trimEnd('/')!=app.client.server.origin) {Text("Use this server")}
            if(app.user!=null) {
                HorizontalDivider()
                ListItem(headlineContent={Text("Follow working agents")},supportingContent={Text("Keep a notification with task progress while Doop is in the background.")},trailingContent={Switch(app.followAgents,{if(it) (context as? MainActivity)?.followAgents() else app.updateFollowAgents(false)})})
                OutlinedButton(onClick={openBrowser(context,app.client.server.origin+"/account")},modifier=Modifier.fillMaxWidth()) {Text("Model accounts and billing")}
                OutlinedButton(onClick={app.action {app.signOut()}},modifier=Modifier.fillMaxWidth()) {Text("Sign out")}
            }
            HorizontalDivider()
            listOf("Privacy policy" to "/privacy","Terms of service" to "/terms").forEach { (label,path) -> TextButton(onClick={openBrowser(context,app.client.server.origin+path)}) {Text(label)} }
            TextButton(onClick={context.startActivity(Intent(Intent.ACTION_SENDTO,Uri.parse("mailto:support@doop.design")))}) {Text("Contact support")}
            if(app.user!=null) TextButton(onClick={app.action {passwordRequired=app.hasPassword();delete=true}},colors=ButtonDefaults.textButtonColors(contentColor=MaterialTheme.colorScheme.error)) {Text("Delete account")}
            Text("Doop ${BuildConfig.VERSION_NAME}",style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
    if(delete) ActionDialog("Delete your account?",{delete=false},"Delete account",{app.deleteAccount(if(passwordRequired) password else null);delete=false}) {
        Text("This permanently deletes your account and canvases only you can access.")
        if(passwordRequired) OutlinedTextField(password,{password=it},label={Text("Password")},visualTransformation=PasswordVisualTransformation())
    }
}

@Composable fun ActionDialog(title:String,onDismiss:()->Unit,label:String="Save",onConfirm:suspend ()->Unit,content:@Composable ColumnScope.()->Unit) {
    var busy by remember {mutableStateOf(false)};var error by remember {mutableStateOf<String?>(null)};val scope=rememberCoroutineScope()
    AlertDialog(onDismissRequest={if(!busy) onDismiss()},title={Text(title)},text={Column(verticalArrangement=Arrangement.spacedBy(12.dp)) {content();error?.let {Text(it,color=MaterialTheme.colorScheme.error)}}},
        confirmButton={TextButton(onClick={busy=true;error=null;scope.launch {try {onConfirm()} catch(e:CancellationException) {throw e} catch(e:Exception) {error=e.message} finally {busy=false}}},enabled=!busy) {Text(if(busy) "Working…" else label)}},
        dismissButton={TextButton(onClick=onDismiss,enabled=!busy) {Text("Cancel")}})
}
@Composable fun TextEntryDialog(title:String,label:String,initial:String,onDismiss:()->Unit,onSave:suspend (String)->Unit) {
    var text by rememberSaveable(initial) {mutableStateOf(initial)}
    ActionDialog(title,onDismiss,onConfirm={require(text.isNotBlank()) {"Enter a name."};onSave(text.trim())}) {OutlinedTextField(text,{text=it},label={Text(label)},singleLine=true)}
}
@Composable fun ConfirmDialog(title:String,description:String,onDismiss:()->Unit,onConfirm:suspend ()->Unit) {
    ActionDialog(title,onDismiss,"Delete",onConfirm) {Text(description)}
}
