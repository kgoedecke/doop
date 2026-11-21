@file:OptIn(androidx.compose.ui.text.ExperimentalTextApi::class)

package design.doop.android

import androidx.compose.foundation.Image
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.*
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// The same identity and typefaces as src/styles.css and the iOS app.
val Inter = FontFamily((100..900 step 100).map { weight ->
    Font(R.font.inter, FontWeight(weight), variationSettings = FontVariation.Settings(FontVariation.weight(weight)))
})
val Hanken = FontFamily((100..900 step 100).map { weight ->
    Font(R.font.hanken_grotesk, FontWeight(weight), variationSettings = FontVariation.Settings(FontVariation.weight(weight)))
})
val DoopBlue = Color(0xFF2683DE)

private fun type(size: Int, line: Int, weight: FontWeight = FontWeight.Normal, hero: Boolean = false) = TextStyle(
    fontFamily = if (hero) Hanken else Inter, fontWeight = weight,
    fontSize = size.sp, lineHeight = line.sp, letterSpacing = if (size >= 20) (-.3).sp else 0.sp
)
private val DoopTypography = Typography(
    displayLarge = type(48, 54, FontWeight.Light, true), displayMedium = type(40, 46, FontWeight.Light, true),
    displaySmall = type(34, 40, FontWeight.Light, true), headlineLarge = type(30, 36, FontWeight.Medium),
    headlineMedium = type(24, 30, FontWeight.Medium), headlineSmall = type(20, 26, FontWeight.SemiBold),
    titleLarge = type(18, 24, FontWeight.SemiBold), titleMedium = type(15, 21, FontWeight.SemiBold),
    titleSmall = type(13, 19, FontWeight.Medium), bodyLarge = type(15, 23), bodyMedium = type(14, 21),
    bodySmall = type(12, 18), labelLarge = type(14, 20, FontWeight.Medium),
    labelMedium = type(12, 16, FontWeight.Medium), labelSmall = type(11, 15, FontWeight.Medium)
)

@Composable fun DoopTheme(content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    val ink = if (dark) Color(0xFFF2F2F2) else Color(0xFF111111)
    val surface = if (dark) Color(0xFF1C1C1C) else Color.White
    val paper = if (dark) Color(0xFF141414) else Color(0xFFFDFDFD)
    val inset = if (dark) Color(0xFF242424) else Color(0xFFF7F7F7)
    val muted = if (dark) Color(0xFFA9A8A5) else Color(0xFF5F5E5B)
    val line = if (dark) Color(0xFF3A3A3A) else Color(0xFFDCDCDC)
    val base = if (dark) darkColorScheme() else lightColorScheme()
    val palette = base.copy(
        primary = ink, onPrimary = surface, primaryContainer = ink, onPrimaryContainer = surface,
        secondary = ink, onSecondary = surface, secondaryContainer = inset, onSecondaryContainer = ink,
        tertiary = DoopBlue, onTertiary = Color.White, tertiaryContainer = inset, onTertiaryContainer = ink,
        background = paper, onBackground = ink, surface = surface, onSurface = ink,
        surfaceVariant = inset, onSurfaceVariant = muted, surfaceTint = Color.Transparent,
        surfaceBright = surface, surfaceDim = inset, surfaceContainer = surface,
        surfaceContainerLow = surface, surfaceContainerLowest = paper,
        surfaceContainerHigh = inset, surfaceContainerHighest = inset,
        outline = line, outlineVariant = if (dark) Color(0xFF303030) else Color(0xFFECECEC),
        inverseSurface = ink, inverseOnSurface = surface, inversePrimary = surface,
        error = if (dark) Color(0xFFFF6B57) else Color(0xFFD0341F),
        errorContainer = if (dark) Color(0xFF3B211E) else Color(0xFFFFEFEC),
        onErrorContainer = if (dark) Color(0xFFFFB4A8) else Color(0xFF8D291B)
    )
    MaterialTheme(colorScheme = palette, typography = DoopTypography,
        shapes = Shapes(extraSmall = RoundedCornerShape(6.dp), small = RoundedCornerShape(8.dp),
            medium = RoundedCornerShape(12.dp), large = RoundedCornerShape(16.dp), extraLarge = RoundedCornerShape(24.dp)),
        content = content)
}

@Composable fun DoopLogo(size: Int = 30) {
    Image(painterResource(R.drawable.doop_logo), null, Modifier.size(size.dp))
}

@Composable fun Wordmark() {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        DoopLogo()
        Text("Doop", fontFamily = Inter, fontWeight = FontWeight.ExtraBold, fontSize = 18.sp, letterSpacing = (-.18).sp)
    }
}

@Composable fun Tool(label: String, icon: ImageVector, enabled: Boolean = true, onClick: () -> Unit) {
    IconButton(onClick = onClick, enabled = enabled, modifier = Modifier.size(48.dp)) {
        Icon(icon, contentDescription = label, modifier = Modifier.size(20.dp))
    }
}
