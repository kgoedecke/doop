package design.doop.android

import android.content.ClipData
import android.content.ClipboardManager
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.coroutines.*
import org.json.JSONObject

private val specialists=listOf("ux" to "UX Lead","copy" to "Copywriter","brand" to "Brand Compliance","a11y" to "Accessibility","polish" to "Visual Polish")

@OptIn(ExperimentalMaterial3Api::class)
@Composable fun CanvasScreen(app:AppModel,model:CanvasModel) {
    val context=LocalContext.current;val dark=isSystemInDarkTheme();val scope=rememberCoroutineScope()
    var panel by remember {mutableStateOf<String?>(null)};var menu by remember {mutableStateOf(false)}
    var draft by rememberSaveable(model.id) {mutableStateOf("")};var assignment by rememberSaveable(model.id) {mutableStateOf<String?>(null)}
    var references by rememberSaveable(model.id) {mutableStateOf(listOf<String>())};var sending by remember {mutableStateOf(false)}
    var actionBusy by remember {mutableStateOf(false)};var deleting by remember {mutableStateOf<Pair<Frame,ElementSelection?>?>(null)}
    var inspector by remember {mutableStateOf<Frame?>(null)}
    var scoped by remember(model.selectedId,model.element?.selector) {mutableStateOf(true)}
    var modelMenu by remember {mutableStateOf(false)}
    val view=remember(model) {BlitzCanvasView(context)}
    DisposableEffect(view) {onDispose {view.dispose()}}
    BackHandler {if(panel!=null) panel=null else {app.closeBoard();app.action {app.reload()}}}
    LaunchedEffect(model.deleted) {if(model.deleted) {app.closeBoard();app.restore()}}
    fun runAction(block:suspend ()->Unit) {if(actionBusy) return;actionBusy=true;scope.launch {try {block()} catch(e:CancellationException) {throw e} catch(e:Exception) {model.error=e.message} finally {actionBusy=false}}}
    val selection=model.selected
    Scaffold(topBar={TopAppBar(title={Row(verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(10.dp)) {
        DoopLogo(24)
        Column {
        Text(model.board?.name ?: "Opening canvas…",maxLines=1,overflow=TextOverflow.Ellipsis,fontSize=14.sp,fontWeight=FontWeight.Medium)
        Text(if(model.connected) "Live · ${model.presences.size+1} present" else if(model.connecting) "Connecting…" else "Offline",fontSize=11.sp,color=MaterialTheme.colorScheme.onSurfaceVariant)
    }}},navigationIcon={Tool("Back to library",DoopIcons.ArrowBack) {app.closeBoard();app.action {app.reload()}}},actions={
        Tool("Pages",DoopIcons.Layers) {panel="pages"}
        Box {Tool("Canvas menu",DoopIcons.MoreVert) {menu=true};DropdownMenu(menu,{menu=false}) {
            listOf("Frames" to "frames","Comments" to "comments","Agent tasks" to "tasks","People" to "people").forEach { (title,key) -> DropdownMenuItem(text={Text(title)},onClick={panel=key;menu=false}) }
            DropdownMenuItem(text={Text("Paste")},enabled=model.canEdit,onClick={menu=false;runAction {SelectionActions.paste(context,model)}})
            DropdownMenuItem(text={Text("Share canvas link")},onClick={menu=false;SelectionActions.shareText(context,SelectionActions.link(model,null,null))})
            DropdownMenuItem(text={Text("Open in browser")},onClick={menu=false;openBrowser(context,SelectionActions.link(model))})
        }}
    })}) { padding ->
        Box(Modifier.fillMaxSize().padding(padding).imePadding()) {
            AndroidView(factory={view},update={it.sync(model,dark)},modifier=Modifier.fillMaxSize())
            if(model.board==null && model.connecting) CircularProgressIndicator(Modifier.align(Alignment.Center))
            if(model.board!=null && model.pageFrames.isEmpty()) Column(Modifier.align(Alignment.Center).padding(bottom=140.dp),horizontalAlignment=Alignment.CenterHorizontally) {
                Text("An open canvas.",fontFamily=Hanken,fontSize=32.sp)
                Text("Add a frame, or ask Doop to make something.",fontSize=13.sp,color=MaterialTheme.colorScheme.onSurfaceVariant)
            }
            (model.connectionError ?: model.previewError)?.let { message -> Surface(Modifier.align(Alignment.TopCenter).padding(12.dp),shape=RoundedCornerShape(14.dp),color=MaterialTheme.colorScheme.errorContainer) {
                Row(Modifier.padding(12.dp),verticalAlignment=Alignment.CenterVertically) {Text(message,Modifier.weight(1f),fontSize=12.sp);if(!model.connecting) TextButton(onClick={if(model.connectionError!=null) {model.stop();model.start()} else view.retryPreviews()}) {Text("Retry")}}
            } }
            Surface(Modifier.align(Alignment.TopEnd).padding(top=if(model.connectionError==null && model.previewError==null) 12.dp else 80.dp,end=12.dp),shape=RoundedCornerShape(14.dp),shadowElevation=1.dp,border=BorderStroke(1.dp,MaterialTheme.colorScheme.outlineVariant)) {
                Column {
                    if(model.canUndo) Tool("Undo",DoopIcons.Undo,model.canUndo) {model.action {model.undo()}}
                    Tool("Fit canvas",DoopIcons.FitScreen) {view.fit(null)}
                    Tool("Add frame",DoopIcons.Add,model.canEdit) {model.action {model.addFrame()}}
                    Tool("Frames",DoopIcons.ViewQuilt) {panel="frames"}
                }
            }
            Column(Modifier.align(Alignment.BottomCenter).widthIn(max=680.dp).fillMaxWidth().padding(12.dp),verticalArrangement=Arrangement.spacedBy(8.dp)) {
                if(selection!=null) Surface(shape=RoundedCornerShape(14.dp),shadowElevation=1.dp,border=BorderStroke(1.dp,MaterialTheme.colorScheme.outlineVariant)) {
                    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),horizontalArrangement=Arrangement.Center) {
                        Tool("Copy selection",DoopIcons.ContentCopy,selection!=null && !actionBusy) {val f=selection!!;val e=model.element;runAction {SelectionActions.copy(context,f,e)}}
                        Tool("Paste",DoopIcons.ContentPaste,model.canEdit && !actionBusy) {runAction {SelectionActions.paste(context,model)}}
                        Tool("Duplicate selection",DoopIcons.CopyAll,selection!=null && model.canEdit && !selection.locked && !actionBusy) {
                            val f=selection!!;val e=model.element
                            runAction {if(e==null) model.addFrame(f) else model.patchFrame(f,obj("html" to SelectionActions.edit(context,f,e,"duplicate")))}
                        }
                        Tool("Delete selection",DoopIcons.DeleteOutline,selection!=null && model.canEdit && !selection.locked && !actionBusy) {deleting=selection!! to model.element}
                        Tool("Export selection",DoopIcons.IosShare,selection!=null && !actionBusy) {panel="export"}
                        Tool("Frame properties",DoopIcons.Tune,selection!=null) {inspector=selection}
                    }
                }
                Surface(shape=RoundedCornerShape(18.dp),shadowElevation=2.dp,border=BorderStroke(1.dp,MaterialTheme.colorScheme.outline)) {Column(Modifier.padding(horizontal=10.dp,vertical=8.dp),verticalArrangement=Arrangement.spacedBy(6.dp)) {
                    if(selection!=null && scoped) InputChip(selected=true,onClick={view.fit(selection)},label={Text(model.element?.label ?: selection.name,maxLines=1,overflow=TextOverflow.Ellipsis)},trailingIcon={IconButton(onClick={scoped=false},Modifier.size(28.dp)) {Icon(DoopIcons.Close,"Ask about the whole canvas",Modifier.size(16.dp))}})
                    if(references.isNotEmpty() || assignment!=null) Row(Modifier.horizontalScroll(rememberScrollState()),horizontalArrangement=Arrangement.spacedBy(6.dp)) {
                        assignment?.let { a -> InputChip(selected=true,onClick={assignment=null},label={Text(specialists.find {it.first==a}?.second ?: a)},trailingIcon={Icon(DoopIcons.Close,"Remove agent",Modifier.size(16.dp))}) }
                        references.forEach { r -> InputChip(selected=true,onClick={references=references-r},label={Text(r.substringBefore(" (id:").removePrefix("- "),maxLines=1)},trailingIcon={Icon(DoopIcons.Close,"Remove reference",Modifier.size(16.dp))}) }
                    }
                    BasicTextField(draft,{draft=it},modifier=Modifier.fillMaxWidth().heightIn(min=40.dp,max=120.dp).padding(horizontal=8.dp,vertical=6.dp).semantics {contentDescription="Prompt"},
                        textStyle=MaterialTheme.typography.bodyMedium.copy(color=MaterialTheme.colorScheme.onSurface),cursorBrush=SolidColor(DoopBlue),maxLines=4,
                        decorationBox={inner ->Box {if(draft.isEmpty()) Text("What would you like to make?",style=MaterialTheme.typography.bodyMedium,color=MaterialTheme.colorScheme.onSurfaceVariant);inner()}})
                    Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.CenterVertically) {
                        IconButton(onClick={panel="context"},modifier=Modifier.size(48.dp).semantics {contentDescription="Add context"}) {Text("@",fontSize=20.sp)}
                        Tool("Comment",DoopIcons.ChatBubbleOutline) {panel="comments"}
                        Spacer(Modifier.weight(1f))
                        Box {
                            val account=AccountModelSelection.parse(model.modelAccount)
                            val options=account?.options ?: emptyList()
                            val label=account?.label ?: "Auto"
                            TextButton(onClick={modelMenu=true}) {Text(label,maxLines=1,fontSize=12.sp);Icon(DoopIcons.ExpandMore,null,Modifier.size(16.dp))}
                            DropdownMenu(modelMenu,{modelMenu=false}) {
                                options.forEach { option -> DropdownMenuItem(text={Text(option.optString("name"))},onClick={modelMenu=false;model.action {model.chooseModel(account!!.kind,option.getString("id"))}}) }
                                DropdownMenuItem(text={Text("Connect a model account")},onClick={modelMenu=false;openBrowser(context,model.client.server.origin+"/account")})
                            }
                        }
                        FilledIconButton(onClick={
                            sending=true;val prompt=draft;val refs=references;val agent=assignment;val useScope=scoped
                            scope.launch {try {model.queue(prompt,agent,refs,useScope);if(draft==prompt) draft="";references=emptyList();assignment=null} catch(e:Exception) {model.error=e.message} finally {sending=false}}
                        },colors=IconButtonDefaults.filledIconButtonColors(containerColor=DoopBlue,contentColor=androidx.compose.ui.graphics.Color.White),enabled=draft.isNotBlank() && model.connected && !sending) {if(sending) CircularProgressIndicator(Modifier.size(18.dp),strokeWidth=2.dp) else Icon(DoopIcons.ArrowUpward,"Send prompt",Modifier.size(20.dp))}
                    }
                } }
            }
        }
    }
    if(panel!=null) ModalBottomSheet(onDismissRequest={panel=null},sheetState=rememberModalBottomSheetState(skipPartiallyExpanded=true)) {
        Column(Modifier.fillMaxWidth().heightIn(max=650.dp).padding(horizontal=20.dp).navigationBarsPadding()) {
            Text(when(panel) {"frames"->"Frames";"pages"->"Pages";"comments"->"Comments";"tasks"->"Agent tasks";"people"->"People on this canvas";"context"->"Add context";else->"Export selection"},style=MaterialTheme.typography.headlineSmall,modifier=Modifier.padding(bottom=16.dp))
            when(panel) {
                "frames"->LazyColumn {items(model.pageFrames,key={it.id}) { f ->
                    ListItem(headlineContent={Text(f.name)},supportingContent={Text("${f.width.toInt()} × ${f.height.toInt()}"+(if(f.locked) " · Locked" else "")+(if(f.hidden) " · Hidden" else ""))},modifier=Modifier.clickable {model.select(f.id);view.fit(f);panel=null},
                        trailingContent={Tool("Properties for ${f.name}",DoopIcons.Tune) {inspector=f;panel=null}})
                };item {TextButton(onClick={model.action {model.addFrame()};panel=null},enabled=model.canEdit) {Icon(DoopIcons.Add,null);Text("Add frame")}}}
                "pages"->LazyColumn {items(model.pages,key={it.id}) { p -> ListItem(headlineContent={Text(p.name)},supportingContent={Text("${model.board?.frames?.count { model.board!!.pageOf(it)==p.id } ?: 0} frames")},trailingContent={if(model.activePage==p.id) Icon(DoopIcons.Check,null)},modifier=Modifier.clickable {model.selectPage(p.id);panel=null}) }}
                "comments"->CommentsPanel(model)
                "tasks"->LazyColumn {if(model.tasks.isEmpty()) item {Text("No agent tasks yet. Send a prompt to get started.",Modifier.padding(vertical=24.dp))};items(model.tasks.sortedByDescending {it.optLong("startedAt")},key={it.getString("id")}) { task ->
                    ListItem(headlineContent={Text(task.optString("agentName","Agent"))},supportingContent={Column {Text(task.optString("status"));task.string("failureReason")?.let {Text(it,color=MaterialTheme.colorScheme.error)};task.optJSONArray("pipeline")?.let {Text("Stage ${task.optInt("stage")+1} of ${it.length()}",fontSize=12.sp)}}},leadingContent={Icon(DoopIcons.AutoAwesome,null)})
                }}
                "people"->LazyColumn {items(model.presences,key={it.getString("clientId")}) { p ->ListItem(headlineContent={Text(p.optString("name"))},supportingContent={Text(if(p.optString("kind")=="agent") "Agent" else "Collaborator")},leadingContent={Icon(if(p.optString("kind")=="agent") DoopIcons.AutoAwesome else DoopIcons.Person,null)})};item {Text("You are here as ${app.user?.optString("name") ?: "Android"}.",Modifier.padding(16.dp))}}
                "context"->LazyColumn {
                    fun addReference(kind:String,id:String,name:String) {
                        val ref="- $kind: ${JSONObject.quote(name)} (id: ${JSONObject.quote(id)})"
                        references=(references+ref).distinct();draft=draft.replace(Regex("(^|\\s)@[^\\n]*$"),"$1");panel=null
                    }
                    item {Text("Agents",fontWeight=FontWeight.Bold)}
                    item {ListItem(headlineContent={Text("Doop · automatic")},modifier=Modifier.clickable {assignment=null;panel=null})}
                    items(specialists) { (id,name) ->ListItem(headlineContent={Text(name)},modifier=Modifier.clickable {assignment=id;panel=null})}
                    item {HorizontalDivider();Text("People",fontWeight=FontWeight.Bold,modifier=Modifier.padding(top=12.dp))}
                    app.user?.let { u ->item {ListItem(headlineContent={Text(u.optString("name"))},modifier=Modifier.clickable {addReference("person",u.getString("id"),u.optString("name"))})} }
                    items(model.presences.filter {it.optString("kind")=="user"}.distinctBy {it.string("userId") ?: it.getString("clientId")}) { p ->ListItem(headlineContent={Text(p.optString("name"))},modifier=Modifier.clickable {addReference("person",p.string("userId") ?: "client:"+p.getString("clientId"),p.optString("name"))})}
                    item {HorizontalDivider();Text("Frames",fontWeight=FontWeight.Bold,modifier=Modifier.padding(top=12.dp))}
                    items(model.pageFrames,key={it.id}) { f ->ListItem(headlineContent={Text(f.name)},modifier=Modifier.clickable {addReference("frame",f.id,f.name)})}
                }
                "export"->selection?.let { f ->Column(Modifier.padding(bottom=24.dp),verticalArrangement=Arrangement.spacedBy(12.dp)) {
                    val e=model.element
                    Text(e?.label ?: f.name)
                    Button(onClick={panel=null;runAction {SelectionActions.export(context,model,f,e,true)}},modifier=Modifier.fillMaxWidth()) {Text("Export PNG")}
                    OutlinedButton(onClick={panel=null;runAction {SelectionActions.export(context,model,f,e,false)}},modifier=Modifier.fillMaxWidth()) {Text("Export HTML")}
                    OutlinedButton(onClick={context.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("Doop link",SelectionActions.link(model,f,e)));panel=null},modifier=Modifier.fillMaxWidth()) {Text("Copy selection link")}
                    Text("Sharing a link keeps the canvas’s existing access settings.",fontSize=12.sp,color=MaterialTheme.colorScheme.onSurfaceVariant)
                }}
            }
            Spacer(Modifier.height(24.dp))
        }
    }
    inspector?.let { frame ->FrameInspector(model,frame) {inspector=null} }
    deleting?.let { (f,e) ->ConfirmDialog(if(e==null) "Delete ${f.name}?" else "Delete ${e.label}?","You can undo this change during this session.",{deleting=null}) {
        if(e==null) model.deleteFrame(f) else model.patchFrame(f,obj("html" to SelectionActions.edit(context,f,e,"delete")))
        deleting=null
    } }
    model.error?.let {message ->AlertDialog(onDismissRequest={model.error=null},title={Text("Couldn’t finish")},text={Text(message)},confirmButton={TextButton(onClick={model.error=null}) {Text("OK")}})}
}

@Composable private fun CommentsPanel(model:CanvasModel) {
    var draft by rememberSaveable {mutableStateOf("")};var sending by remember {mutableStateOf(false)};val scope=rememberCoroutineScope()
    val frame=model.selected;val element=model.element
    Column {
        Text(if(frame==null) "Comment on ${model.pages.find {it.id==model.activePage}?.name ?: "this page"}" else "Comment on ${element?.label ?: frame.name}",fontSize=13.sp)
        OutlinedTextField(draft,{draft=it},label={Text("Write a comment")},modifier=Modifier.fillMaxWidth().padding(top=8.dp),maxLines=4)
        Button(onClick={val text=draft;sending=true;scope.launch {try {model.comment(text,frame,element);if(draft==text) draft=""} catch(e:Exception) {model.error=e.message} finally {sending=false}}},enabled=draft.isNotBlank() && !sending && model.connected) {Text(if(sending) "Posting…" else "Post comment")}
        val comments=model.pageComments.filter {it.string("resolvedAt")==null}
        LazyColumn(Modifier.heightIn(max=340.dp)) {
            if(comments.isEmpty()) item {Text("No open comments on this page.",Modifier.padding(vertical=24.dp))}
            items(comments.sortedByDescending {it.optLong("at")},key={it.getString("id")}) {c ->ListItem(headlineContent={Text(c.optString("from"),fontWeight=FontWeight.Medium)},supportingContent={Text(c.optString("text"))},modifier=Modifier.clickable {c.string("frameId")?.let {model.select(it);model.viewportCommand++}})}
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable private fun FrameInspector(model:CanvasModel,original:Frame,onDismiss:()->Unit) {
    var name by rememberSaveable(original.id) {mutableStateOf(original.name)};var width by rememberSaveable(original.id) {mutableStateOf(original.width.toInt().toString())}
    var height by rememberSaveable(original.id) {mutableStateOf(original.height.toInt().toString())};var html by remember(original.id) {mutableStateOf(original.html)}
    var busy by remember {mutableStateOf(false)};var error by remember {mutableStateOf<String?>(null)};val scope=rememberCoroutineScope()
    ModalBottomSheet(onDismissRequest={if(!busy) onDismiss()},sheetState=rememberModalBottomSheetState(skipPartiallyExpanded=true)) {
        Column(Modifier.fillMaxWidth().imePadding().verticalScroll(rememberScrollState()).padding(20.dp),verticalArrangement=Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment=Alignment.CenterVertically) {Text("Frame properties",style=MaterialTheme.typography.headlineSmall,modifier=Modifier.weight(1f));TextButton(onClick=onDismiss,enabled=!busy) {Text("Close")}}
            if(original.locked) {
                Text("This frame is locked.")
                Button(onClick={model.action {model.patchFrame(original,obj("locked" to false));onDismiss()}},enabled=model.canEdit) {Text("Unlock frame")}
            }
            OutlinedTextField(name,{name=it},label={Text("Name")},modifier=Modifier.fillMaxWidth(),enabled=!original.locked,singleLine=true)
            Row(horizontalArrangement=Arrangement.spacedBy(12.dp)) {
                OutlinedTextField(width,{width=it},label={Text("Width")},modifier=Modifier.weight(1f),keyboardOptions=KeyboardOptions(keyboardType=KeyboardType.Number),enabled=!original.locked,singleLine=true)
                OutlinedTextField(height,{height=it},label={Text("Height")},modifier=Modifier.weight(1f),keyboardOptions=KeyboardOptions(keyboardType=KeyboardType.Number),enabled=!original.locked,singleLine=true)
            }
            OutlinedTextField(html,{html=it},label={Text("Frame HTML")},modifier=Modifier.fillMaxWidth().height(280.dp),textStyle=MaterialTheme.typography.bodySmall.copy(fontFamily=FontFamily.Monospace),enabled=!original.locked)
            error?.let {Text(it,color=MaterialTheme.colorScheme.error)}
            Button(onClick={busy=true;scope.launch {try {
                val w=width.toFloatOrNull();val h=height.toFloatOrNull()
                require(name.isNotBlank() && w!=null && h!=null && w.isFinite() && h.isFinite() && w in 1f..10000f && h in 1f..10000f) {"Enter a name and dimensions between 1 and 10,000."}
                val patch=JSONObject()
                if(name!=original.name) patch.put("name",name)
                if(w!=original.width) patch.put("width",w)
                if(h!=original.height) patch.put("height",h)
                if(html!=original.html) patch.put("html",html)
                if(patch.length()>0) model.patchFrame(original,patch)
                onDismiss()
            } catch(e:Exception) {error=e.message} finally {busy=false}}},enabled=model.canEdit && !original.locked && !busy,modifier=Modifier.fillMaxWidth()) {Text(if(busy) "Saving…" else "Save changes")}
            if(!original.locked) TextButton(onClick={model.action {model.patchFrame(original,obj("locked" to true));onDismiss()}},enabled=model.canEdit) {Text("Lock frame")}
            Spacer(Modifier.height(16.dp))
        }
    }
}
