package design.doop.android

import android.graphics.Bitmap
import android.graphics.RectF
import kotlinx.coroutines.asCoroutineDispatcher
import java.util.concurrent.Executors
import kotlin.math.*

object BlitzNative {
    init { System.loadLibrary("doop_android") }
    // Blitz documents are thread-confined, including destruction and hit testing.
    val dispatcher=Executors.newSingleThreadExecutor { r -> Thread(r,"DoopBlitz").apply { isDaemon=true } }.asCoroutineDispatcher()
    external fun create(html:ByteArray,base:ByteArray,width:Int,height:Int):Long
    external fun destroy(pointer:Long)
    external fun loading(pointer:Long):Boolean
    external fun animating(pointer:Long):Boolean
    external fun pick(pointer:Long,x:Float,y:Float,selector:ByteArray?):ByteArray?
    external fun render(pointer:Long,bitmap:Bitmap,scale:Float,x:Float,y:Float,w:Float,h:Float,time:Double):Boolean
    fun paint(pointer:Long,region:RectF,density:Float,time:Double=0.0,pixelBudget:Float=2_000_000f):Bitmap {
        require(region.width()>0 && region.height()>0 && region.width().isFinite() && region.height().isFinite())
        require(density.isFinite() && density>0 && pixelBudget>=16384)
        // Reserve rounding headroom below the JNI allocation cap. Rust promotes
        // BOTH f32 operands to f64 before multiplying; Float multiplication here
        // can round a 136.499997… pixel edge up to 136.5 and allocate one extra pixel.
        val budget=pixelBudget.coerceAtMost(8_000_000f)-8192f
        val scale=minOf(density,4095f/max(region.width(),region.height()),sqrt(budget/(region.width()*region.height())))
        // A sliver at the viewport edge still needs one physical pixel. Never ask
        // the native renderer for a zero-sized buffer when zoomed far out.
        val width=max(region.width(),1f/scale)
        val height=max(region.height(),1f/scale)
        val bitmap=Bitmap.createBitmap((width.toDouble()*scale.toDouble()).roundToInt(),
            (height.toDouble()*scale.toDouble()).roundToInt(),Bitmap.Config.ARGB_8888)
        try {
            check(render(pointer,bitmap,scale,region.left,region.top,width,height,time)) { "Could not render this design." }
            return bitmap
        } catch(e:Throwable) { bitmap.recycle();throw e }
    }
}
