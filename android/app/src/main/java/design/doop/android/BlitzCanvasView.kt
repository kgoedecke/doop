package design.doop.android

import android.content.Context
import android.graphics.*
import android.view.*
import kotlinx.coroutines.*
import org.json.JSONObject
import kotlin.math.*

class BlitzCanvasView(context:Context):View(context) {
    private val scope=CoroutineScope(SupervisorJob()+Dispatchers.Main.immediate)
    private var model:CanvasModel?=null
    private var frames=emptyList<Frame>()
    private val entries=mutableMapOf<String,Entry>()
    private class Entry(val frame:Frame) {
        var ptr=0L;var bitmap:Bitmap?=null;var region=RectF();var scale=0f;var rendering=false
        var loading=false;var animating=false;var dirty=true;var failed=false;var seen=0L;var lastPaint=0L
    }
    private var cameraX=0f;private var cameraY=0f;private var zoom=1f
    private val dp=resources.displayMetrics.density
    private val labelFont=androidx.core.content.res.ResourcesCompat.getFont(context,R.font.inter)
    private val paint=Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
    private var command=-1;private var page="";private var fitted=false
    private var lastState="";private var dark=false;private var drag:Frame?=null
    private var dragOrigin=PointF();private var dragPosition=PointF();private var down=PointF();private var last=PointF()
    private var guideX:Float?=null;private var guideY:Float?=null
    private var moved=false;private var pinching=false;private var lastPresence=0L
    private var disposed=false
    private val zoomGesture=ScaleGestureDetector(context,object:ScaleGestureDetector.SimpleOnScaleGestureListener() {
        override fun onScaleBegin(detector:ScaleGestureDetector):Boolean { pinching=true;drag=null;return true }
        override fun onScale(detector:ScaleGestureDetector):Boolean {
            val wx=(detector.focusX-cameraX)/zoom;val wy=(detector.focusY-cameraY)/zoom
            zoom=(zoom*detector.scaleFactor).coerceIn(.0001f*dp,16f*dp)
            cameraX=detector.focusX-wx*zoom;cameraY=detector.focusY-wy*zoom;invalidate();return true
        }
    })
    private val taps=GestureDetector(context,object:GestureDetector.SimpleOnGestureListener() {
        override fun onDown(e:MotionEvent)=true
        override fun onSingleTapConfirmed(e:MotionEvent):Boolean {
            if(moved || pinching) return false
            val frame=frameAt(e.x,e.y)
            model?.select(frame?.id)
            if(frame!=null && e.y >= cameraY+frame.y*zoom) pick(frame,e.x,e.y)
            performClick();invalidate();return true
        }
        override fun onDoubleTap(e:MotionEvent):Boolean {
            val frame=frameAt(e.x,e.y)
            if(frame==null) fit(null) else {
                model?.select(frame.id)
                val fitScale=min((width-64*dp)/frame.width,(height-230*dp)/frame.height)
                if(abs(zoom-fitScale)<fitScale*.12f) {
                    val wx=(e.x-cameraX)/zoom;val wy=(e.y-cameraY)/zoom
                    zoom=(fitScale*2.5f).coerceAtMost(16*dp);cameraX=width/2f-wx*zoom;cameraY=(height-180*dp)/2-wy*zoom
                } else fit(frame)
            }
            invalidate();return true
        }
    })
    init { isFocusable=true;contentDescription="Design canvas. Pinch to zoom, drag to pan, double tap to fit. Move frames by their titles." }
    fun sync(value:CanvasModel,isDark:Boolean) {
        model=value;dark=isDark;frames=value.pageFrames.filterNot { it.hidden }
        if(page!=value.activePage) { page=value.activePage;fitted=false }
        if(command!=value.viewportCommand) { command=value.viewportCommand;post { fit(value.selected) } }
        if(!fitted && frames.isNotEmpty() && width>0) { fit(null);fitted=true }
        val state=frames.joinToString { "${it.id}:${it.html.hashCode()}:${it.width}:${it.height}" }
        if(lastState!=state) {
            lastState=state
            entries.keys.toList().forEach { id ->
                val f=frames.find { it.id==id };val entry=entries[id]!!
                if(f==null || f.html!=entry.frame.html || f.width!=entry.frame.width || f.height!=entry.frame.height) release(id)
            }
        }
        invalidate()
    }
    fun fit(frame:Frame?) {
        val targets=if(frame!=null) listOf(frame) else frames
        if(targets.isEmpty() || width==0 || height==0) return
        val left=targets.minOf { it.x };val top=targets.minOf { it.y };val right=targets.maxOf { it.x+it.width };val bottom=targets.maxOf { it.y+it.height }
        val availableW=max(100f,width-72*dp);val availableH=max(100f,height-240*dp)
        zoom=canvasFitScale(right-left,bottom-top,availableW,availableH,dp)
        cameraX=width/2f-(left+right)/2*zoom;cameraY=40*dp+availableH/2-(top+bottom)/2*zoom
        fitted=true;invalidate()
    }
    override fun onSizeChanged(w:Int,h:Int,oldw:Int,oldh:Int) { if(!fitted) fit(null) }
    private fun bounds(f:Frame):RectF {
        val x=if(drag?.id==f.id) dragPosition.x else f.x;val y=if(drag?.id==f.id) dragPosition.y else f.y
        return RectF(cameraX+x*zoom,cameraY+y*zoom,cameraX+(x+f.width)*zoom,cameraY+(y+f.height)*zoom)
    }
    private fun frameAt(x:Float,y:Float)=frames.asReversed().firstOrNull { bounds(it).apply { top-=32*dp }.contains(x,y) }
    override fun onDraw(canvas:Canvas) {
        super.onDraw(canvas)
        canvas.drawColor(if(dark) Color.rgb(20,20,20) else Color.rgb(245,245,245))
        val now=android.os.SystemClock.uptimeMillis()
        var animations=0
        for(f in frames) {
            val rect=bounds(f)
            if(rect.right<0 || rect.left>width || rect.bottom<0 || rect.top>height) continue
            val e=entries.getOrPut(f.id) { Entry(f) };e.seen=now
            paint.color=Color.WHITE;paint.style=Paint.Style.FILL;canvas.drawRect(rect,paint)
            e.bitmap?.let {
                val dest=RectF(rect.left+e.region.left*zoom,rect.top+e.region.top*zoom,rect.left+e.region.right*zoom,rect.top+e.region.bottom*zoom)
                canvas.drawBitmap(it,null,dest,paint)
            }
            if(e.failed) {
                paint.color=if(dark) Color.LTGRAY else Color.GRAY;paint.textSize=12*dp
                if(rect.width()>110*dp) canvas.drawText("Preview unavailable",rect.left+12*dp,max(rect.top+24*dp,24*dp),paint)
            }
            val worker=model?.streams?.get(f.id) ?: model?.presences?.firstOrNull { it.optString("kind")=="agent" && it.optString("activeFrameId")==f.id }
            paint.color=if(model?.selectedId==f.id) Color.rgb(1,119,211) else if(worker!=null) color(worker.optString("color")) else if(dark) Color.DKGRAY else Color.LTGRAY
            paint.style=Paint.Style.STROKE;paint.strokeWidth=if(model?.selectedId==f.id) 2*dp else dp;canvas.drawRect(rect,paint);paint.style=Paint.Style.FILL
            paint.color=if(dark) Color.LTGRAY else Color.DKGRAY;paint.textSize=12*dp;paint.typeface=labelFont
            val label=(if(f.locked) "🔒 " else "")+f.name
            canvas.drawText(label.take(paint.breakText(label,true,max(20f,rect.width()),null)),rect.left,rect.top-9*dp,paint)
            worker?.let {
                paint.color=color(it.optString("color"));paint.textSize=10*dp
                val text=it.optString("name","Agent")+if(model?.streams?.containsKey(f.id)==true) " is designing…" else " is editing"
                canvas.drawText(text,rect.left,rect.top-25*dp,paint)
            }
            val region=RectF(max(0f,(-rect.left)/zoom-40),max(0f,(-rect.top)/zoom-40),min(f.width,(width-rect.left)/zoom+40),min(f.height,(height-rect.top)/zoom+40))
            val animate=e.animating && drag==null && !pinching && rect.width()>100*dp && animations++<2
            if(!e.rendering && !e.failed && region.width()>0 && region.height()>0 &&
                (e.dirty || abs(e.scale-zoom.coerceAtMost(8f))>zoom*.15f || !e.region.contains(region) || (e.loading && now-e.lastPaint>180) || (animate && now-e.lastPaint>45))) render(e,region,zoom.coerceAtMost(8f),animate)
            if(!e.failed && (e.loading || animate)) postInvalidateDelayed(if(animate) 50 else 200)
        }
        model?.element?.let { e -> frames.find { it.id==e.frameId && it.html==e.html }?.let { f ->
            val r=bounds(f);paint.color=Color.rgb(1,119,211);paint.style=Paint.Style.STROKE;paint.strokeWidth=2*dp
            canvas.drawRect(r.left+e.x*zoom,r.top+e.y*zoom,r.left+(e.x+e.width)*zoom,r.top+(e.y+e.height)*zoom,paint);paint.style=Paint.Style.FILL
        } }
        paint.color=Color.rgb(1,119,211);paint.strokeWidth=dp
        guideX?.let { canvas.drawLine(cameraX+it*zoom,0f,cameraX+it*zoom,height.toFloat(),paint) }
        guideY?.let { canvas.drawLine(0f,cameraY+it*zoom,width.toFloat(),cameraY+it*zoom,paint) }
        model?.presences?.filter { it.optJSONObject("viewport")?.string("pageId").let { p -> p==null || p==page } }?.forEach { p -> p.optJSONObject("cursor")?.let { c ->
            val x=cameraX+c.optDouble("x").toFloat()*zoom;val y=cameraY+c.optDouble("y").toFloat()*zoom
            paint.color=color(p.optString("color"));canvas.drawCircle(x,y,4*dp,paint);paint.textSize=11*dp
            canvas.drawText(p.optString("name"),x+7*dp,y-7*dp,paint)
        } }
        entries.filterValues { now-it.seen>3000 && !it.rendering }.keys.toList().forEach(::release)
        if(now-lastPresence>150) {lastPresence=now;model?.presence(-cameraX/zoom,-cameraY/zoom,zoom,width/zoom,height/zoom)}
    }
    private fun render(e:Entry,region:RectF,density:Float,animate:Boolean) {
        val base=model?.client?.server?.origin ?: return
        e.rendering=true
        scope.launch {
            try {
                val rendered=withContext(BlitzNative.dispatcher) {
                    if(e.ptr==0L) e.ptr=BlitzNative.create(e.frame.html.toByteArray(),base.toByteArray(),e.frame.width.toInt(),e.frame.height.toInt())
                    check(e.ptr!=0L) { "Could not create the design renderer." }
                    val bitmap=BlitzNative.paint(e.ptr,region,density,android.os.SystemClock.uptimeMillis()/1000.0,if(animate) 550000f else 2000000f)
                    Triple(bitmap,BlitzNative.loading(e.ptr),BlitzNative.animating(e.ptr))
                }
                if(entries[e.frame.id]===e && !disposed) {
                    e.bitmap=rendered.first;e.region=RectF(region);e.scale=density;e.loading=rendered.second;e.animating=rendered.third;e.dirty=false;e.lastPaint=android.os.SystemClock.uptimeMillis()
                }
            } catch(ex:CancellationException) { throw ex } catch(ex:Exception) {
                e.failed=true;e.dirty=false
                model?.previewError="A frame preview couldn’t be drawn."
                android.util.Log.w("DoopRenderer","Preview failed at ${region.width()} × ${region.height()}, scale $density",ex)
            }
            finally { e.rendering=false;invalidate() }
        }
    }
    fun retryPreviews() {
        entries.values.forEach { it.failed=false;it.dirty=true };model?.previewError=null;invalidate()
    }
    private fun pick(frame:Frame,x:Float,y:Float) {
        val e=entries[frame.id] ?: return;val rect=bounds(frame)
        val px=(x-rect.left)/zoom;val py=(y-rect.top)/zoom
        scope.launch {
            val info=withContext(BlitzNative.dispatcher) { if(e.ptr==0L) null else BlitzNative.pick(e.ptr,px,py,null)?.let { JSONObject(it.toString(Charsets.UTF_8)) } }
            if(info!=null && model?.selectedId==frame.id && model?.selected?.html==frame.html) {
                model?.element=runCatching { ElementSelection.parse(frame,info) }.getOrNull();invalidate()
            }
        }
    }
    private fun release(id:String) {
        val entry=entries.remove(id) ?: return
        // Queue destruction after any outstanding render, even after the View scope closes.
        CoroutineScope(BlitzNative.dispatcher).launch { if(entry.ptr!=0L) {BlitzNative.destroy(entry.ptr);entry.ptr=0};entry.bitmap=null }
    }
    fun dispose() { disposed=true;entries.keys.toList().forEach(::release);scope.cancel() }
    override fun performClick():Boolean { super.performClick();return true }
    override fun onTouchEvent(event:MotionEvent):Boolean {
        parent.requestDisallowInterceptTouchEvent(true)
        zoomGesture.onTouchEvent(event);taps.onTouchEvent(event)
        when(event.actionMasked) {
            MotionEvent.ACTION_DOWN->{
                down=PointF(event.x,event.y);last=PointF(event.x,event.y);moved=false;pinching=false
                val frame=frameAt(event.x,event.y)
                drag=frame?.takeIf { model?.canEdit==true && !it.locked && event.y<bounds(it).top }
                drag?.let { dragOrigin=PointF(it.x,it.y);dragPosition=PointF(it.x,it.y);model?.select(it.id) }
            }
            MotionEvent.ACTION_MOVE->if(!zoomGesture.isInProgress && !pinching) {
                if(hypot(event.x-down.x,event.y-down.y)>ViewConfiguration.get(context).scaledTouchSlop) moved=true
                if(moved) {
                    val f=drag
                    if(f!=null) {
                        val snap=snapFrame(f,dragOrigin.x+(event.x-down.x)/zoom,dragOrigin.y+(event.y-down.y)/zoom,frames,zoom/dp)
                        dragPosition=PointF(snap.x,snap.y);guideX=snap.guideX;guideY=snap.guideY
                    } else {cameraX+=event.x-last.x;cameraY+=event.y-last.y}
                }
                last=PointF(event.x,event.y);invalidate()
            }
            MotionEvent.ACTION_UP,MotionEvent.ACTION_CANCEL->{
                if(event.actionMasked==MotionEvent.ACTION_UP && moved) drag?.let { model?.moveFrame(it,dragPosition.x,dragPosition.y) }
                drag=null;guideX=null;guideY=null;postInvalidateDelayed(100)
            }
        }
        return true
    }
    private fun color(s:String)=runCatching { Color.parseColor(s) }.getOrDefault(Color.rgb(1,119,211))
}
