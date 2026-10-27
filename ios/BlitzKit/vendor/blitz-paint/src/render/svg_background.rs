//! Rasterize SVG background tiles with their filters, then let the image brush
//! repeat them. anyrender_svg omits filters (a turbulence rect becomes black).
use std::cell::RefCell;
use std::collections::VecDeque;
use std::sync::{Arc, Weak};

use peniko::{Blob, ImageAlphaType, ImageData, ImageFormat};

// Keep zoomed textures bounded on phones. Weak keys neither retain documents nor
// confuse a new SVG with an old one when an allocator reuses a tree's address.
const MAX_SIDE: f64 = 4096.0;
const MAX_PIXELS: f64 = 4_194_304.0;
const CACHE_BYTES: usize = 16 * 1024 * 1024;
const CACHE_ENTRIES: usize = 32;

struct CachedTile {
    tree: Weak<usvg::Tree>,
    image: ImageData,
}

thread_local! {
    static TILES: RefCell<VecDeque<CachedTile>> = const { RefCell::new(VecDeque::new()) };
}

pub(super) fn rasterize(tree: &Arc<usvg::Tree>, width: f64, height: f64) -> Option<ImageData> {
    if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
        return None;
    }
    let reduction = (MAX_SIDE / width)
        .min(MAX_SIDE / height)
        .min((MAX_PIXELS / (width * height)).sqrt())
        .min(1.0);
    let width = (width * reduction).floor().max(1.0) as u32;
    let height = (height * reduction).floor().max(1.0) as u32;
    let key = Arc::downgrade(tree);

    TILES.with_borrow_mut(|tiles| {
        tiles.retain(|tile| tile.tree.strong_count() > 0);
        if let Some(index) = tiles.iter().position(|tile| {
            tile.tree.ptr_eq(&key) && tile.image.width == width && tile.image.height == height
        }) {
            let tile = tiles.remove(index).unwrap();
            let image = tile.image.clone();
            tiles.push_back(tile);
            return Some(image);
        }

        let mut pixmap = resvg::tiny_skia::Pixmap::new(width, height)?;
        resvg::render(
            tree,
            resvg::tiny_skia::Transform::from_scale(
                width as f32 / tree.size().width(),
                height as f32 / tree.size().height(),
            ),
            &mut pixmap.as_mut(),
        );
        let image = ImageData {
            data: Blob::new(Arc::new(pixmap.take())),
            format: ImageFormat::Rgba8,
            alpha_type: ImageAlphaType::AlphaPremultiplied,
            width,
            height,
        };
        let bytes = |image: &ImageData| image.width as usize * image.height as usize * 4;
        let mut total = tiles.iter().map(|tile| bytes(&tile.image)).sum::<usize>() + bytes(&image);
        while total > CACHE_BYTES || tiles.len() >= CACHE_ENTRIES {
            let Some(tile) = tiles.pop_front() else { break };
            total -= bytes(&tile.image);
        }
        tiles.push_back(CachedTile {
            tree: key,
            image: image.clone(),
        });
        Some(image)
    })
}
