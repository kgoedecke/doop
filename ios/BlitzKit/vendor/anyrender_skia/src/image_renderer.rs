use anyrender::{ImageRenderer, RenderContext};
use debug_timer::debug_timer;
use skia_safe::{AlphaType, Color, ColorType, ImageInfo, SurfaceProps, graphics, surfaces};

use crate::{SkiaScenePainter, scene::SkiaSceneCache};

pub struct SkiaImageRenderer {
    image_info: ImageInfo,
    surface_props: SurfaceProps,
    scene_cache: SkiaSceneCache,
}

impl RenderContext for SkiaImageRenderer {}
impl ImageRenderer for SkiaImageRenderer {
    type ScenePainter<'a>
        = SkiaScenePainter<'a>
    where
        Self: 'a;

    fn new(width: u32, height: u32) -> Self {
        graphics::set_font_cache_count_limit(100);
        graphics::set_typeface_cache_count_limit(100);
        graphics::set_resource_cache_total_bytes_limit(10485760);

        Self {
            image_info: ImageInfo::new(
                (width as i32, height as i32),
                ColorType::RGBA8888,
                AlphaType::Opaque,
                None,
            ),
            surface_props: SurfaceProps::default(),
            scene_cache: SkiaSceneCache::default(),
        }
    }

    fn resize(&mut self, width: u32, height: u32) {
        self.image_info = ImageInfo::new(
            (width as i32, height as i32),
            ColorType::RGBA8888,
            AlphaType::Opaque,
            None,
        );
    }

    fn reset(&mut self) {}

    fn render_to_vec<F: FnOnce(&mut Self::ScenePainter<'_>)>(
        &mut self,
        draw_fn: F,
        buffer: &mut Vec<u8>,
    ) {
        debug_timer!(timer, feature = "log_frame_times");

        buffer.resize(self.image_info.compute_min_byte_size(), 0);

        let mut surface = surfaces::wrap_pixels(
            &self.image_info,
            &mut buffer[..],
            None,
            Some(&self.surface_props),
        )
        .unwrap();

        // Clear surface with transparent background to allow transparency in rendered images
        surface.canvas().clear(Color::TRANSPARENT);

        draw_fn(&mut SkiaScenePainter {
            inner: surface.canvas(),
            cache: &mut self.scene_cache,
        });
        timer.record_time("render");

        self.scene_cache.next_gen();
        timer.record_time("cache next gen");

        timer.print_times("skia_raster: ");
    }

    fn render<F: FnOnce(&mut Self::ScenePainter<'_>)>(&mut self, draw_fn: F, buffer: &mut [u8]) {
        debug_timer!(timer, feature = "log_frame_times");

        let mut surface = surfaces::wrap_pixels(
            &self.image_info,
            &mut buffer[..],
            None,
            Some(&self.surface_props),
        )
        .unwrap();

        // Clear surface with transparent background to allow transparency in rendered images
        surface.canvas().clear(Color::TRANSPARENT);

        draw_fn(&mut SkiaScenePainter {
            inner: surface.canvas(),
            cache: &mut self.scene_cache,
        });
        timer.record_time("render");

        self.scene_cache.next_gen();
        timer.record_time("cache next gen");

        timer.print_times("skia_raster: ");
    }
}
