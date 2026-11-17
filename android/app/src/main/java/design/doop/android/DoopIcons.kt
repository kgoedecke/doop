package design.doop.android

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.unit.dp

// Lucide 1.59.0, the same icon family as src/components/ui/icons.tsx.
// ISC license and Feather attribution: assets/Lucide-LICENSE.txt.
object DoopIcons {
    private fun icon(name:String,vararg paths:String)=ImageVector.Builder(name,24.dp,24.dp,24f,24f).apply {
        paths.forEach { addPath(PathParser().parsePathString(it).toNodes(),stroke=SolidColor(Color.Black),
            strokeLineWidth=1.5f,strokeLineCap=StrokeCap.Round,strokeLineJoin=StrokeJoin.Round) }
    }.build()
    val ArrowBack = icon("arrow-left","m12 19-7-7 7-7","M19 12H5")
    val Undo = icon("undo-2","M9 14 4 9l5-5","M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11")
    val Layers = icon("layers","M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z","M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12","M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17")
    val MoreVert = icon("ellipsis","M11.0,12.0 A1.0,1.0 0 1 0 13.0,12.0 A1.0,1.0 0 1 0 11.0,12.0","M18.0,12.0 A1.0,1.0 0 1 0 20.0,12.0 A1.0,1.0 0 1 0 18.0,12.0","M4.0,12.0 A1.0,1.0 0 1 0 6.0,12.0 A1.0,1.0 0 1 0 4.0,12.0")
    val FitScreen = icon("scan","M3 7V5a2 2 0 0 1 2-2h2","M17 3h2a2 2 0 0 1 2 2v2","M21 17v2a2 2 0 0 1-2 2h-2","M7 21H5a2 2 0 0 1-2-2v-2")
    val Add = icon("plus","M5 12h14","M12 5v14")
    val ViewQuilt = icon("panels-top-left","M5.0,3.0 H19.0 Q21.0,3.0 21.0,5.0 V19.0 Q21.0,21.0 19.0,21.0 H5.0 Q3.0,21.0 3.0,19.0 V5.0 Q3.0,3.0 5.0,3.0 Z","M3 9h18","M9 21V9")
    val ContentCopy = icon("copy","M10.0,8.0 H20.0 Q22.0,8.0 22.0,10.0 V20.0 Q22.0,22.0 20.0,22.0 H10.0 Q8.0,22.0 8.0,20.0 V10.0 Q8.0,8.0 10.0,8.0 Z","M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2")
    val ContentPaste = icon("clipboard","M9.0,2.0 H15.0 Q16.0,2.0 16.0,3.0 V5.0 Q16.0,6.0 15.0,6.0 H9.0 Q8.0,6.0 8.0,5.0 V3.0 Q8.0,2.0 9.0,2.0 Z","M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2")
    val CopyAll = icon("copy-plus","M15,12 L15,18","M12,15 L18,15","M10.0,8.0 H20.0 Q22.0,8.0 22.0,10.0 V20.0 Q22.0,22.0 20.0,22.0 H10.0 Q8.0,22.0 8.0,20.0 V10.0 Q8.0,8.0 10.0,8.0 Z","M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2")
    val DeleteOutline = icon("trash-2","M10 11v6","M14 11v6","M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6","M3 6h18","M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2")
    val ChatBubbleOutline = icon("message-square","M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z")
    val IosShare = icon("upload","M12 3v12","m17 8-5-5-5 5","M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4")
    val Tune = icon("sliders-horizontal","M10 5H3","M12 19H3","M14 3v4","M16 17v4","M21 12h-9","M21 19h-5","M21 5h-7","M8 10v4","M8 12H3")
    val Close = icon("x","M18 6 6 18","m6 6 12 12")
    val ExpandMore = icon("chevron-down","m6 9 6 6 6-6")
    val ArrowUpward = icon("arrow-up","m5 12 7-7 7 7","M12 19V5")
    val Search = icon("search","m21 21-4.34-4.34","M3.0,11.0 A8.0,8.0 0 1 0 19.0,11.0 A8.0,8.0 0 1 0 3.0,11.0")
    val Settings = icon("settings-2","M14 17H5","M19 7h-9","M14.0,17.0 A3.0,3.0 0 1 0 20.0,17.0 A3.0,3.0 0 1 0 14.0,17.0","M4.0,7.0 A3.0,3.0 0 1 0 10.0,7.0 A3.0,3.0 0 1 0 4.0,7.0")
    val AutoAwesome = icon("sparkles","M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z","M20 2v4","M22 4h-4","M2.0,20.0 A2.0,2.0 0 1 0 6.0,20.0 A2.0,2.0 0 1 0 2.0,20.0")
    val Refresh = icon("refresh-cw","M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8","M21 3v5h-5","M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16","M8 16H3v5")
    val Person = icon("user-round","M7.0,8.0 A5.0,5.0 0 1 0 17.0,8.0 A5.0,5.0 0 1 0 7.0,8.0","M20 21a8 8 0 0 0-16 0")
    val Check = icon("check","M20 6 9 17l-5-5")
    val Key = icon("key-round","M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z","M16.0,7.5 A0.5,0.5 0 1 0 17.0,7.5 A0.5,0.5 0 1 0 16.0,7.5")
    val Dashboard = icon("panels-top-left","M5.0,3.0 H19.0 Q21.0,3.0 21.0,5.0 V19.0 Q21.0,21.0 19.0,21.0 H5.0 Q3.0,21.0 3.0,19.0 V5.0 Q3.0,3.0 5.0,3.0 Z","M3 9h18","M9 21V9")
    val Send = icon("arrow-up","m5 12 7-7 7 7","M12 19V5")
}
