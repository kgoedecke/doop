package design.doop.android

import android.graphics.Color
import android.graphics.RectF
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class BlitzRenderTest {
    @Test fun fractionalZoomAndSubpixelTilesRenderWithoutSizeMismatch()=runBlocking {
        withContext(BlitzNative.dispatcher) {
            val ptr=BlitzNative.create("<body style='margin:0;width:390px;height:9000px;background:#ff0000'></body>".toByteArray(),"https://doop.design".toByteArray(),390,9000)
            try {
                for(scale in listOf(.35f,.15f,.05f,.035f,1.05f,2.625f)) {
                    val bitmap=BlitzNative.paint(ptr,RectF(0f,0f,390f,844f),scale)
                    assertEquals(Color.RED,bitmap.getPixel(bitmap.width/2,bitmap.height/2));bitmap.recycle()
                }
                // Panning a tall frame can leave less than one pixel at the viewport edge.
                for(region in listOf(RectF(0f,4000f,.01f,5000f),RectF(20f,4000f,200f,4000.01f))) {
                    val bitmap=BlitzNative.paint(ptr,region,.05f)
                    assertTrue(bitmap.width>=1 && bitmap.height>=1);assertEquals(Color.RED,bitmap.getPixel(0,0));bitmap.recycle()
                }
            } finally {BlitzNative.destroy(ptr)}
        }
    }

    @Test fun nativeRendererLoadsNetworkImages()=runBlocking {
        val server=okhttp3.mockwebserver.MockWebServer()
        val image=android.graphics.Bitmap.createBitmap(10,10,android.graphics.Bitmap.Config.ARGB_8888).apply {eraseColor(Color.MAGENTA)}
        val bytes=java.io.ByteArrayOutputStream().also {image.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it)}.toByteArray()
        image.recycle()
        server.enqueue(okhttp3.mockwebserver.MockResponse().setHeader("Content-Type","image/png").setBody(okio.Buffer().write(bytes)))
        server.start()
        try {
            withContext(BlitzNative.dispatcher) {
                val html="<body style='margin:0'><img width='80' height='80' src='${server.url("/image.png")}'></body>"
                val ptr=BlitzNative.create(html.toByteArray(),server.url("/").toString().toByteArray(),100,100)
                try {
                    withTimeout(15000) {
                        while(true) {
                            val painted=BlitzNative.paint(ptr,RectF(0f,0f,100f,100f),1f)
                            val pixel=painted.getPixel(40,40);painted.recycle()
                            if(pixel==Color.MAGENTA) break
                            delay(100)
                        }
                    }
                } finally {BlitzNative.destroy(ptr)}
            }
        } finally {server.shutdown()}
    }
    @Test fun nativeRendererPaintsCssSvgAndUnicodeAndFindsElements()= runBlocking {
        withContext(BlitzNative.dispatcher) {
            val html="""<!doctype html><html><body style="margin:0;width:200px;height:200px;background:#ff0000"><div id="card" style="width:100px;height:50px;background:#00ff00">Hello 🚀</div><svg width="40" height="40"><rect width="40" height="40" fill="blue"/></svg></body></html>"""
            val ptr=BlitzNative.create(html.toByteArray(),"https://doop.design".toByteArray(),200,200)
            assertNotEquals(0,ptr)
            try {
                val image=BlitzNative.paint(ptr,RectF(0f,0f,200f,200f),1f)
                assertEquals(Color.RED,image.getPixel(150,150))
                assertEquals(Color.GREEN,image.getPixel(80,40))
                assertEquals(Color.BLUE,image.getPixel(20,70))
                val node=JSONObject(String(BlitzNative.pick(ptr,20f,30f,"#card".toByteArray())!!))
                assertEquals("card",node.getString("idAttr"))
                assertTrue(node.getString("text").contains("🚀"))
                assertEquals(100.0,node.getJSONArray("rect").getDouble(2),.1)
                val tile=BlitzNative.paint(ptr,RectF(100f,100f,150f,150f),2f)
                assertEquals(100,tile.width);assertEquals(Color.RED,tile.getPixel(50,50))
                image.recycle();tile.recycle()
            } finally {BlitzNative.destroy(ptr)}
        }
    }
    @Test fun nativeRendererLoadsAndroidSystemFonts()=runBlocking {
        withContext(BlitzNative.dispatcher) {
            val ptr=BlitzNative.create("<body style='margin:0;background:white;color:black;font:24px sans-serif'>Android text</body>".toByteArray(),"https://doop.design".toByteArray(),240,100)
            try {
                val image=BlitzNative.paint(ptr,RectF(0f,0f,240f,100f),1f)
                var dark=0
                for(y in 0 until 50) for(x in 0 until 240) if(Color.red(image.getPixel(x,y))<100) dark++
                assertTrue("System fonts must draw visible glyphs",dark>100)
                image.recycle()
            } finally {BlitzNative.destroy(ptr)}
        }
    }
}
