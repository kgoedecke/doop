use anyrender::{RenderContext, WindowRenderer};
use debug_timer::debug_timer;
use skia_safe::{Color, Surface, graphics};
use std::any::Any;
use std::sync::Arc;

use crate::{SkiaScenePainter, scene::SkiaSceneCache};

pub(crate) trait SkiaBackend: Any {
    fn set_size(&mut self, width: u32, height: u32);

    fn prepare(&mut self) -> Option<Surface>;

    fn flush(&mut self, surface: Surface);
}

enum RenderState {
    Active(Box<ActiveRenderState>),
    Suspended,
}

struct ActiveRenderState {
    backend: Box<dyn SkiaBackend>,
    scene_cache: SkiaSceneCache,
}

/// Options for configuring the Skia renderer.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct SkiaRendererOptions {
    /// Background color used to clear the canvas.
    pub base_color: Color,
    /// Alpha mode used when compositing the window surface.
    pub composite_alpha_mode: anyrender::CompositeAlphaMode,
}

impl Default for SkiaRendererOptions {
    fn default() -> Self {
        Self::new()
    }
}

impl SkiaRendererOptions {
    pub const fn new() -> Self {
        Self {
            base_color: Color::WHITE,
            composite_alpha_mode: anyrender::CompositeAlphaMode::Auto,
        }
    }

    pub const fn base_color(self, base_color: Color) -> Self {
        Self { base_color, ..self }
    }

    pub const fn composite_alpha_mode(
        self,
        composite_alpha_mode: anyrender::CompositeAlphaMode,
    ) -> Self {
        Self {
            composite_alpha_mode,
            ..self
        }
    }
}

impl From<anyrender::RendererConfig> for SkiaRendererOptions {
    fn from(config: anyrender::RendererConfig) -> Self {
        let mut options = Self::default();
        if let Some(color) = config.base_color {
            let rgba8 = color.to_rgba8();
            options.base_color = skia_safe::Color::from_argb(rgba8.a, rgba8.r, rgba8.g, rgba8.b);
        }
        if let Some(mode) = config.composite_alpha_mode {
            options.composite_alpha_mode = mode;
        }
        options
    }
}

pub struct SkiaWindowRenderer {
    render_state: RenderState,
    options: SkiaRendererOptions,
}

impl Default for SkiaWindowRenderer {
    fn default() -> Self {
        Self::new()
    }
}

impl SkiaWindowRenderer {
    pub fn new() -> Self {
        Self {
            render_state: RenderState::Suspended,
            options: SkiaRendererOptions::default(),
        }
    }
    pub fn with_options(options: impl Into<SkiaRendererOptions>) -> Self {
        Self {
            render_state: RenderState::Suspended,
            options: options.into(),
        }
    }
}

impl SkiaWindowRenderer {}

impl RenderContext for SkiaWindowRenderer {}
impl WindowRenderer for SkiaWindowRenderer {
    type ScenePainter<'a>
        = SkiaScenePainter<'a>
    where
        Self: 'a;

    fn resume<F: FnOnce() + 'static>(
        &mut self,
        window: Arc<dyn anyrender::WindowHandle>,
        width: u32,
        height: u32,
        on_ready: F,
    ) {
        graphics::set_font_cache_count_limit(100);
        graphics::set_typeface_cache_count_limit(100);
        graphics::set_resource_cache_total_bytes_limit(10485760);

        #[cfg(any(target_os = "macos", target_os = "ios"))]
        let backend = crate::metal::MetalBackend::new(
            window,
            width,
            height,
            self.options.composite_alpha_mode,
        );
        #[cfg(not(any(target_os = "macos", target_os = "ios")))]
        let backend = crate::opengl::OpenGLBackend::new(
            window,
            width,
            height,
            self.options.composite_alpha_mode,
        );

        self.render_state = RenderState::Active(Box::new(ActiveRenderState {
            backend: Box::new(backend),
            scene_cache: SkiaSceneCache::default(),
        }));
        on_ready();
    }

    fn complete_resume(&mut self) -> bool {
        true
    }

    fn suspend(&mut self) {
        self.render_state = RenderState::Suspended;
    }

    fn is_active(&self) -> bool {
        matches!(self.render_state, RenderState::Active(..))
    }

    fn set_size(&mut self, width: u32, height: u32) {
        if let RenderState::Active(state) = &mut self.render_state {
            state.backend.set_size(width, height);
        }
    }

    fn render<F: FnOnce(&mut Self::ScenePainter<'_>)>(&mut self, draw_fn: F) {
        let RenderState::Active(state) = &mut self.render_state else {
            return;
        };

        debug_timer!(timer, feature = "log_frame_times");

        let mut surface = match state.backend.prepare() {
            Some(it) => it,
            None => return,
        };

        surface.canvas().restore_to_count(1);
        surface.canvas().clear(self.options.base_color);

        draw_fn(&mut SkiaScenePainter {
            inner: surface.canvas(),
            cache: &mut state.scene_cache,
        });
        timer.record_time("cmd");

        state.backend.flush(surface);
        timer.record_time("render");

        state.scene_cache.next_gen();
        timer.record_time("cache next gen");

        timer.print_times("skia: ");
    }
}

#[cfg(any(
    feature = "pixels_window_renderer",
    feature = "softbuffer_window_renderer"
))]
pub mod raster {
    #[cfg(feature = "pixels_window_renderer")]
    pub use pixels_window_renderer::PixelsRendererOptions;
    #[cfg(feature = "pixels_window_renderer")]
    pub use pixels_window_renderer::PixelsWindowRenderer;

    #[cfg(feature = "softbuffer_window_renderer")]
    pub use softbuffer_window_renderer::{SoftbufferRendererOptions, SoftbufferWindowRenderer};

    #[cfg(feature = "pixels_window_renderer")]
    pub type SkiaRasterWindowRenderer =
        PixelsWindowRenderer<crate::image_renderer::SkiaImageRenderer>;
    #[cfg(feature = "pixels_window_renderer")]
    pub type SkiaRasterRendererOptions = PixelsRendererOptions;

    #[cfg(all(
        feature = "softbuffer_window_renderer",
        not(feature = "pixels_window_renderer")
    ))]
    pub type SkiaRasterWindowRenderer =
        SoftbufferWindowRenderer<crate::image_renderer::SkiaImageRenderer>;
    #[cfg(all(
        feature = "softbuffer_window_renderer",
        not(feature = "pixels_window_renderer")
    ))]
    pub type SkiaRasterRendererOptions = SoftbufferRendererOptions;
}
