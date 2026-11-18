package design.doop.android

import android.app.*
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.*

/** User-enabled, visible background monitoring. No Apple push credentials are reused. */
class AgentFollowService:Service() {
    private val scope=CoroutineScope(SupervisorJob()+Dispatchers.Main.immediate)
    private var polling:Job?=null
    private var client:DoopClient?=null
    override fun onBind(intent:Intent?):IBinder?=null
    override fun onStartCommand(intent:Intent?,flags:Int,startId:Int):Int {
        if(intent?.action=="stop") {
            getSharedPreferences("settings",0).edit().putBoolean("followAgents",false).apply();stopSelf();return START_NOT_STICKY
        }
        val manager=getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel("agents","Agent progress",NotificationManager.IMPORTANCE_LOW))
        val first=notification("Following your agents","Checking task progress…",null)
        if(Build.VERSION.SDK_INT>=29) startForeground(410,first,ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC) else startForeground(410,first)
        if(polling==null) polling=scope.launch {
            val server=getSharedPreferences("settings",0).getString("server","https://doop.design")!!
            val api=DoopClient(this@AgentFollowService,ServerAddress.parse(server,BuildConfig.DEBUG));client=api
            while(isActive) {
                try {
                    val active=api.list("/api/canvases").filter {it.objects("activeTasks").isNotEmpty()}
                    val count=active.sumOf {it.objects("activeTasks").size}
                    val title=if(count==0) "Following your agents" else "$count ${if(count==1) "agent is" else "agents are"} working"
                    val detail=if(active.isEmpty()) "Watching for task progress. Tap Stop to end." else active.joinToString(" · ") {it.optString("name")}
                    manager.notify(410,notification(title,detail,active.firstOrNull()?.optString("id")))
                } catch(e:CancellationException) {throw e} catch(e:ApiException) {
                    if(e.status==401 || e.status==403) {stopSelf();break}
                    manager.notify(410,notification("Agent updates paused","Waiting to reconnect…",null))
                } catch(_:Exception) {manager.notify(410,notification("Agent updates paused","Waiting to reconnect…",null))}
                delay(15000)
            }
        }
        return START_NOT_STICKY
    }
    private fun notification(title:String,detail:String,canvas:String?):Notification {
        val open=Intent(this,MainActivity::class.java).apply {canvas?.let {putExtra("canvasId",it)}}
        val pending=PendingIntent.getActivity(this,0,open,PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val stop=PendingIntent.getService(this,1,Intent(this,AgentFollowService::class.java).setAction("stop"),PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        return NotificationCompat.Builder(this,"agents").setSmallIcon(android.R.drawable.ic_popup_sync)
            .setContentTitle(title).setContentText(detail).setStyle(NotificationCompat.BigTextStyle().bigText(detail))
            .setContentIntent(pending).setOnlyAlertOnce(true).setOngoing(true).addAction(0,"Stop",stop).build()
    }
    override fun onTimeout(startId:Int,fgsType:Int) {stopSelf()}
    override fun onDestroy() {
        getSharedPreferences("settings",0).edit().putBoolean("followAgents",false).apply()
        scope.cancel();client?.close();stopForeground(STOP_FOREGROUND_REMOVE);super.onDestroy()
    }
    companion object {
        fun setEnabled(context:Context,enabled:Boolean) {
            val intent=Intent(context,AgentFollowService::class.java)
            if(enabled) ContextCompat.startForegroundService(context,intent) else context.stopService(intent)
        }
    }
}
