package design.doop.android

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.net.URI

class ModelTest {
    @Test fun fittingTallBoardsKeepsAllFramesInsideTheViewport() {
        val scale=canvasFitScale(1400f,40000f,900f,1400f,2.625f)
        assertEquals(.035f,scale,.00001f)
        assertTrue(40000f*scale<=1400f && 1400f*scale<=900f)
        assertEquals(10.5f,canvasFitScale(1f,1f,900f,1400f,2.625f),.00001f)
    }

    @Test fun serverAddressRejectsCredentialsPathsAndInsecureRemoteHosts() {
        for(value in listOf("http://doop.design","https://user:pass@doop.design","https://doop.design/path","https://doop.design?token=x","https://doop.design/#x"))
            assertTrue(value,runCatching {ServerAddress.parse(value,true)}.isFailure)
        assertEquals("https://doop.design",ServerAddress.parse(" https://DOOP.design/ ").origin)
        assertTrue(runCatching {ServerAddress.parse("http://10.0.2.2:3109")}.isFailure)
        assertEquals("http://10.0.2.2:3109",ServerAddress.parse("http://10.0.2.2:3109",true).origin)
        assertTrue(runCatching {ServerAddress.parse("https://doop.design").api("//evil.test/api")}.isFailure)
    }
    @Test fun authCallbacksRequireMatchingFreshChallengeAndCannotReplayAmbiguousQueries() {
        val a=AuthAttempt("abc","https://doop.design",1000)
        assertEquals("hello+world",a.token(URI("doop://auth?challenge=abc&token=hello%2Bworld"),2000))
        for(link in listOf("doop://auth?challenge=wrong&token=x","https://auth?challenge=abc&token=x","doop://auth?challenge=abc&token=","doop://auth?challenge=abc&token=a&token=b")) assertNull(a.token(URI(link),2000))
        assertNull(a.token(URI("doop://auth?challenge=abc&token=x"),601001))
        assertNull(a.token(URI("doop://auth?challenge=abc&token=x"),999))
        val generated=AuthAttempt.create("https://doop.design")
        assertTrue(generated.challenge.matches(Regex("[0-9a-f]{32}")))
    }
    @Test fun legacyPagesAndFrameDimensionsAreValidated() {
        val board=Board.parse(JSONObject("""{"id":"c","name":"Canvas","frames":[{"id":"f","width":100,"height":200,"html":""}]}"""))
        assertEquals("c:page1",board.pageOf(board.frames.first()))
        assertTrue(runCatching {Frame.parse(JSONObject("""{"id":"f","width":100000,"height":200}"""))}.isFailure)
    }
    @Test fun modelPickerUsesEnabledDefaultAccountAndItsOwnMenu() {
        val view=JSONObject("""{"default":"openai-key","accounts":[
            {"kind":"anthropic-key","enabled":true,"model":"unrelated"},
            {"kind":"openai-key","enabled":true,"model":"fast"}],
            "menus":{"openai-key":[{"id":"fast","name":"Fast model"},{"id":"careful","name":"Careful model"}]}}""")
        val selected=AccountModelSelection.parse(view)!!
        assertEquals("openai-key",selected.kind)
        assertEquals("Fast model",selected.label)
        assertEquals(listOf("fast","careful"),selected.options.map {it.getString("id")})
        view.getJSONArray("accounts").getJSONObject(1).put("enabled",false)
        assertNull(AccountModelSelection.parse(view))
        view.put("default","claude-local")
        assertNull(AccountModelSelection.parse(view))
        assertNull(AccountModelSelection.parse(JSONObject("""{"accounts":[],"menus":{}}""")))
    }
    @Test fun frameRoundTripRetainsVersionAndLayoutWithoutReusingVersionOnCreate() {
        val frame=Frame.parse(JSONObject("""{"id":"f","canvasId":"c","name":"Rotated","width":100,"height":200,
            "updatedAt":1780000000123,"z":42.5,"rotation":-33.5,"pageId":"p","hidden":true,"locked":true}"""))
        assertEquals(1780000000123L,frame.updatedAt)
        assertEquals(42.5,frame.body().getDouble("z"),0.0)
        assertEquals(-33.5,frame.body().getDouble("rotation"),0.0)
        assertEquals(frame,Frame.parse(frame.json()))
        assertFalse(frame.body().has("updatedAt"))
        assertFalse(frame.body().has("expectedUpdatedAt"))
    }
    @Test fun snappingIsScreenSpaceAndIncludesCenters() {
        val f=Frame("f","c","A",0f,0f,100f,200f,"")
        val other=f.copy(id="g",x=300f,y=400f)
        assertEquals(200f,snapFrame(f,205f,0f,listOf(other),1f).x)
        assertEquals(205f,snapFrame(f,205f,0f,listOf(other),2f).x)
        assertEquals(300f,snapFrame(f,302f,0f,listOf(other),1f).guideX)
        assertEquals(302f,snapFrame(f,302f,0f,listOf(other.copy(hidden=true)),1f).x)
    }
}
