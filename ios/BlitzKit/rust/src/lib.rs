//! C ABI around the Blitz HTML/CSS engine for the doop iOS canvas.
//!
//! One `Doc` per frame. Swift owns the pointer, drives every call from a
//! single serial queue, and frees it with `doopblitz_doc_free`. Coordinates
//! are CSS pixels in the frame's own space; rendered buffers are RGBA8 at
//! `frame size × scale` physical pixels.

use std::ffi::{CStr, CString, c_char};
use std::sync::{Arc, Mutex, OnceLock};

use anyrender::{PaintScene as _, render_to_buffer};
#[cfg(feature = "skia")]
use anyrender_skia::SkiaImageRenderer as ImageBackend;
#[cfg(all(feature = "vello-cpu", not(feature = "skia")))]
use anyrender_vello_cpu::VelloCpuImageRenderer as ImageBackend;
use blitz_dom::{BaseDocument, DocumentConfig, FontContext, RestyleHint, local_name, node::NodeData, util::Color};
use blitz_traits::NodeId;
use blitz_html::HtmlDocument;
use blitz_net::Provider;
use blitz_paint::{paint_scene, paint_scene_region};
use blitz_traits::net::{NetHandler, NetProvider, NetWaker, Request};
use blitz_traits::shell::{ColorScheme, Viewport};
use peniko::Fill;
use peniko::kurbo::{Affine, Rect};

type WakeCallback = extern "C" fn(doc_id: usize);

static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
static WAKE: Mutex<Option<WakeCallback>> = Mutex::new(None);

static FONTS: OnceLock<Mutex<FontContext>> = OnceLock::new();

/// One font context for the whole process. Blitz would otherwise build a new
/// one per document, and each loads the system font files again; with many
/// frames on a board that was gigabytes of resident memory. Clones share the
/// system fonts while each document keeps its own @font-face registrations.
fn base_font_context() -> FontContext {
    FONTS
        .get_or_init(|| {
            use parley::fontique::{Blob, Collection, CollectionOptions, SourceCache};
            let mut ctx = FontContext {
                source_cache: SourceCache::new_shared(),
                collection: Collection::new(CollectionOptions { shared: false, system_fonts: true }),
            };
            ctx.collection.register_fonts(Blob::new(Arc::new(blitz_dom::BULLET_FONT) as _), None);
            add_symbol_fallbacks(&mut ctx.collection);
            Mutex::new(ctx)
        })
        .lock()
        .unwrap()
        .clone()
}

/// System families that carry the symbols pages use as text (★ ✓ → ● ⌘ ✦), first match wins.
/// System Font and Apple Symbols come first, as WebKit's cascade picks them; a family the
/// device lacks is skipped.
#[cfg(not(target_os = "android"))]
const SYMBOL_FAMILIES: &[&str] =
    &["System Font", "Apple Symbols", "Hiragino Sans", "Menlo", "Zapf Dingbats", "STIX Two Math"];
#[cfg(target_os = "android")]
const SYMBOL_FAMILIES: &[&str] =
    &["Noto Sans Symbols", "Noto Sans Symbols 2", "Noto Sans Math", "Noto Color Emoji"];

/// Fontique finds a fallback per script from one sample letter, and symbols belong to no
/// script of their own: a ★ in a Latin run only gets the Latin fallback (Helvetica), and a
/// run of symbols and digits gets none. On macOS Helvetica happens to carry ★; on iOS it
/// does not, so the glyph came from LastResort. Append the symbol families after the
/// system's own fallback for Latin and for the common, inherited and unknown scripts.
fn add_symbol_fallbacks(collection: &mut parley::fontique::Collection) {
    use parley::fontique::{FallbackKey, Script};
    let symbols: Vec<_> = SYMBOL_FAMILIES.iter().filter_map(|name| collection.family_id(name)).collect();
    for script in [*b"Latn", *b"Zyyy", *b"Zinh", *b"Zzzz"] {
        let key = FallbackKey::new(Script::from_bytes(script), None);
        // Asking first records the system's own choice, which appending would otherwise replace.
        let system: Vec<_> = collection.fallback_families(key).collect();
        let extra = symbols.iter().copied().filter(|id| !system.contains(id));
        collection.append_fallbacks(key, extra);
    }
}

fn runtime() -> &'static tokio::runtime::Runtime {
    RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("tokio runtime")
    })
}

struct Waker;
impl NetWaker for Waker {
    fn wake(&self, doc_id: usize) {
        if let Some(cb) = *WAKE.lock().unwrap() {
            cb(doc_id);
        }
    }
}

pub struct Doc {
    document: HtmlDocument,
    net: Arc<Provider>,
    /// The URL the frame is served from (the Doop server's origin). The document's own
    /// `<base href>` is resolved against it on every parse, so it is kept rather than the result.
    base_url: String,
    width: u32,
    height: u32,
    scale: f32,
}

type Fetch = (usize, Request, Box<dyn NetHandler>);

/// The document's network provider. It holds the fetches a parse starts (images, linked
/// stylesheets) until the document's base URL is known, since Blitz starts them while it
/// parses, before a `<base>` can be read; once released it passes every fetch (fonts and
/// images found later by stylesheets) straight to `net`.
struct HeldFetches {
    net: Arc<Provider>,
    held: Mutex<Option<Vec<Fetch>>>,
}

impl NetProvider for HeldFetches {
    fn fetch(&self, doc_id: usize, request: Request, handler: Box<dyn NetHandler>) {
        let mut held = self.held.lock().unwrap();
        match held.as_mut() {
            Some(fetches) => fetches.push((doc_id, request, handler)),
            None => {
                drop(held);
                self.net.fetch(doc_id, request, handler);
            }
        }
    }
}

impl HeldFetches {
    fn new(net: &Arc<Provider>) -> Self {
        Self { net: Arc::clone(net), held: Mutex::new(Some(Vec::new())) }
    }

    fn release(&self) {
        let fetches = self.held.lock().unwrap().take().unwrap_or_default();
        for (doc_id, request, handler) in fetches {
            self.net.fetch(doc_id, request, handler);
        }
    }
}

/// The base URL a browser gives a document served from `fallback`: the first `<base>` with an
/// `href`, resolved against `fallback`, else `fallback` itself. Only http(s) results count: a
/// `javascript:`, `data:` or `file:` base (or one that does not parse) leaves `fallback`, so a
/// frame cannot point its relative URLs at the device's files.
fn document_base_url(document: &BaseDocument, fallback: &url::Url) -> url::Url {
    let href = document
        .query_selector("base[href]")
        .ok()
        .flatten()
        .and_then(|id| document.get_node(id))
        .and_then(|node| node.attr(local_name!("href")));
    href.and_then(|href| fallback.join(href).ok())
        .filter(|url| matches!(url.scheme(), "http" | "https"))
        .unwrap_or_else(|| fallback.clone())
}

fn parse(html: &str, base_url: &str, net: Arc<dyn NetProvider>, width: u32, height: u32, scale: f32) -> HtmlDocument {
    HtmlDocument::from_html(
        html,
        DocumentConfig {
            base_url: Some(base_url.to_string()),
            net_provider: Some(net),
            viewport: Some(viewport(width, height, scale)),
            font_ctx: Some(base_font_context()),
            ..Default::default()
        },
    )
}

impl Doc {
    fn new(html: &str, base_url: &str, width: u32, height: u32, scale: f32) -> Self {
        let _guard = runtime().enter();
        let net = Arc::new(Provider::new(Some(Arc::new(Waker) as Arc<dyn NetWaker>)));
        // Parse against the server origin with the fetches held. An imported page carries
        // `<base href="https://site/">` for its `/img/x.png` paths; when its base differs, parse
        // again against it and drop the held fetches (they point at the Doop server), as a
        // browser resolves every URL against the document's base.
        let held = Arc::new(HeldFetches::new(&net));
        let mut document = parse(html, base_url, Arc::clone(&held) as _, width, height, scale);
        let own_base = url::Url::parse(base_url).ok().and_then(|fallback| {
            Some(document_base_url(document.as_ref(), &fallback)).filter(|resolved| *resolved != fallback)
        });
        match own_base {
            Some(resolved) => {
                drop(document);
                document = parse(html, resolved.as_str(), Arc::clone(&net) as _, width, height, scale);
            }
            None => held.release(),
        }
        // Icon sprites: inline SVG is drawn from standalone markup, so `<use>` references are
        // expanded into clones that inherit from the `<use>` site, as a browser's shadow tree does.
        document.as_mut().expand_svg_use_elements();
        Self { document, net, base_url: base_url.to_string(), width, height, scale }
    }

    fn base(&self) -> &BaseDocument {
        self.document.as_ref()
    }

    fn base_mut(&mut self) -> &mut BaseDocument {
        self.document.as_mut()
    }
}

fn viewport(width: u32, height: u32, scale: f32) -> Viewport {
    let mut viewport = Viewport::new(
        (width as f32 * scale).round().max(1.0) as u32,
        (height as f32 * scale).round().max(1.0) as u32,
        scale,
        ColorScheme::Light,
    );
    // Frames are mostly painted as still pictures at time 0 (playback runs only for large
    // frames on screen), and pages hide content until an entry animation has run: `opacity: 0`
    // plus a `forwards` fade-in, sometimes frozen at `animation-duration: 0s`, which Stylo never
    // starts. Matching `prefers-reduced-motion: reduce` takes the fallback such pages ship.
    viewport.reduced_motion = true;
    viewport
}

unsafe fn cstr<'a>(ptr: *const c_char) -> &'a str {
    if ptr.is_null() {
        return "";
    }
    unsafe { CStr::from_ptr(ptr) }.to_str().unwrap_or("")
}

fn into_c_string(value: String) -> *mut c_char {
    CString::new(value.replace('\0', "")).map(CString::into_raw).unwrap_or(std::ptr::null_mut())
}

// ---------------------------------------------------------------------------
// Lifecycle

/// Register the callback fired (from a network thread) whenever a document's
/// pending font or image fetch completes and it should be painted again.
#[unsafe(no_mangle)]
pub extern "C" fn doopblitz_set_wake_callback(callback: Option<WakeCallback>) {
    *WAKE.lock().unwrap() = callback;
}

/// Parse `html` as a frame of `width`×`height` CSS pixels, rendered at `scale`.
#[unsafe(no_mangle)]
pub extern "C" fn doopblitz_doc_new(
    html: *const c_char,
    base_url: *const c_char,
    width: u32,
    height: u32,
    scale: f32,
) -> *mut Doc {
    let html = unsafe { cstr(html) };
    let base_url = unsafe { cstr(base_url) };
    Box::into_raw(Box::new(Doc::new(html, base_url, width, height, scale)))
}

#[unsafe(no_mangle)]
pub extern "C" fn doopblitz_doc_free(doc: *mut Doc) {
    if !doc.is_null() {
        let _guard = runtime().enter();
        drop(unsafe { Box::from_raw(doc) });
    }
}

/// The id reported to the wake callback for this document. It changes when
/// the HTML is replaced, so Swift re-reads it after `doopblitz_doc_set_html`.
#[unsafe(no_mangle)]
pub extern "C" fn doopblitz_doc_id(doc: *const Doc) -> usize {
    let doc = unsafe { &*doc };
    doc.base().id()
}

/// Replace the document with a fresh parse of `html` (streamed agent chunks,
/// collaborator edits). Keeps size, scale and the server URL; the new HTML's own
/// `<base href>`, if any, is resolved against it again.
#[unsafe(no_mangle)]
pub extern "C" fn doopblitz_doc_set_html(doc: *mut Doc, html: *const c_char) {
    let doc = unsafe { &mut *doc };
    let html = unsafe { cstr(html) };
    let (base_url, width, height, scale) = (doc.base_url.clone(), doc.width, doc.height, doc.scale);
    *doc = Doc::new(html, &base_url, width, height, scale);
}

/// Resize the frame and/or change the raster density.
#[unsafe(no_mangle)]
pub extern "C" fn doopblitz_doc_set_viewport(doc: *mut Doc, width: u32, height: u32, scale: f32) {
    let doc = unsafe { &mut *doc };
    if doc.width == width && doc.height == height && (doc.scale - scale).abs() < f32::EPSILON {
        return;
    }
    let rescaled = (doc.scale - scale).abs() >= f32::EPSILON;
    doc.width = width;
    doc.height = height;
    doc.scale = scale;
    let _guard = runtime().enter();
    doc.base_mut().set_viewport(viewport(width, height, scale));
    if rescaled {
        // Stylo snaps device-pixel-dependent values (border and outline widths) at
        // cascade time. Blitz rebuilds its device on a scale change but does not
        // recascade, so a frame first styled at a tiny scale keeps hairlines that
        // were snapped up to one device pixel: thick borders once zoomed in.
        if let Some(root) = doc.base().try_root_element().map(|n| n.id) {
            if let Some(node) = doc.base_mut().get_node_mut(root) {
                node.set_restyle_hint(RestyleHint::recascade_subtree());
            }
        }
    }
}

/// True when the document has running CSS animations or transitions, so a
/// caller that wants motion should keep painting it with increasing `time`.
#[unsafe(no_mangle)]
pub extern "C" fn doopblitz_doc_is_animating(doc: *const Doc) -> bool {
    let doc = unsafe { &*doc };
    doc.base().is_animating()
}

/// True while fonts or images are still being fetched for this document, or have
/// arrived but not been applied yet (a stylesheet whose fonts are fetched on the next paint).
#[unsafe(no_mangle)]
pub extern "C" fn doopblitz_doc_loading(doc: *const Doc) -> bool {
    let doc = unsafe { &*doc };
    !doc.net.is_empty() || doc.base().has_pending_events()
}

// ---------------------------------------------------------------------------
// Painting

/// Resolve style and layout, then paint the document into a new RGBA8 buffer
/// of `*out_width`×`*out_height` physical pixels. Free it with
/// `doopblitz_buffer_free`. Returns null when the frame has no area.

/// Re-round the resolved layout to the device-pixel grid.
///
/// Taffy rounds every box to whole CSS pixels after layout, so at a paint scale
/// above 1 a box on a half-pixel edge (a 1.5px outline, an 8px handle centred on
/// it) gets a different number of device pixels on each side. Below 1 the CSS
/// grid is finer than the device grid, so a one-device-pixel border (Stylo snaps
/// hairlines up to one) came out one or two CSS pixels wide depending on where
/// the box sat: a faint line here, a heavy one there. Browsers keep sub-pixel
/// layout and snap at paint time instead; this pass does the same arithmetic as
/// `taffy::round_layout`, but on the `1 / scale` grid, at every scale.
fn round_layout_to_device(doc: &mut BaseDocument, scale: f32) {
    use taffy::{NodeId as TaffyId, RoundTree, TraversePartialTree};
    if scale <= 0.0 || !scale.is_finite() {
        return;
    }
    fn walk(doc: &mut BaseDocument, node: TaffyId, scale: f32, cumulative_x: f32, cumulative_y: f32) {
        let round = |v: f32| (v * scale).round() / scale;
        let unrounded = doc.get_unrounded_layout(node);
        let mut layout = unrounded;
        let (parent_x, parent_y) = (cumulative_x, cumulative_y);
        let cumulative_x = cumulative_x + unrounded.location.x;
        let cumulative_y = cumulative_y + unrounded.location.y;
        let (w, h) = (unrounded.size.width, unrounded.size.height);
        layout.location.x = round(cumulative_x) - round(parent_x);
        layout.location.y = round(cumulative_y) - round(parent_y);
        layout.size.width = round(cumulative_x + w) - round(cumulative_x);
        layout.size.height = round(cumulative_y + h) - round(cumulative_y);
        layout.scrollbar_size.width = round(unrounded.scrollbar_size.width);
        layout.scrollbar_size.height = round(unrounded.scrollbar_size.height);
        layout.border.left = round(cumulative_x + unrounded.border.left) - round(cumulative_x);
        layout.border.right = round(cumulative_x + w) - round(cumulative_x + w - unrounded.border.right);
        layout.border.top = round(cumulative_y + unrounded.border.top) - round(cumulative_y);
        layout.border.bottom = round(cumulative_y + h) - round(cumulative_y + h - unrounded.border.bottom);
        layout.padding.left = round(cumulative_x + unrounded.padding.left) - round(cumulative_x);
        layout.padding.right = round(cumulative_x + w) - round(cumulative_x + w - unrounded.padding.right);
        layout.padding.top = round(cumulative_y + unrounded.padding.top) - round(cumulative_y);
        layout.padding.bottom = round(cumulative_y + h) - round(cumulative_y + h - unrounded.padding.bottom);
        let overflow = unrounded.scrollable_overflow_rect;
        layout.scrollable_overflow_rect.left = round(cumulative_x + overflow.left) - round(cumulative_x);
        layout.scrollable_overflow_rect.right = round(cumulative_x + overflow.right) - round(cumulative_x);
        layout.scrollable_overflow_rect.top = round(cumulative_y + overflow.top) - round(cumulative_y);
        layout.scrollable_overflow_rect.bottom = round(cumulative_y + overflow.bottom) - round(cumulative_y);
        doc.set_final_layout(node, &layout);
        for index in 0..doc.child_count(node) {
            let child = doc.get_child_id(node, index);
            if !doc.is_out_of_flow(child) {
                walk(doc, child, scale, cumulative_x, cumulative_y);
            }
        }
        for index in 0..doc.hoisted_child_count(node) {
            let child = doc.get_hoisted_child_id(node, index);
            walk(doc, child, scale, cumulative_x, cumulative_y);
        }
    }
    let root: TaffyId = blitz_dom::taffy_node_id(doc.root_element().id);
    walk(doc, root, scale, 0.0, 0.0);
}

#[unsafe(no_mangle)]
pub extern "C" fn doopblitz_doc_render(
    doc: *mut Doc,
    out_width: *mut u32,
    out_height: *mut u32,
    out_len: *mut usize,
) -> *mut u8 {
    doopblitz_doc_render_at(doc, 0.0, out_width, out_height, out_len)
}

/// Like `doopblitz_doc_render`, with CSS animations and transitions advanced
/// to `time` seconds. Pair with `doopblitz_doc_is_animating` to play them.
#[unsafe(no_mangle)]
pub extern "C" fn doopblitz_doc_render_at(
    doc: *mut Doc,
    time: f64,
    out_width: *mut u32,
    out_height: *mut u32,
    out_len: *mut usize,
) -> *mut u8 {
    let doc = unsafe { &mut *doc };
    let _guard = runtime().enter();
    let scale = doc.scale as f64;
    let width = (doc.width as f64 * scale).round() as u32;
    let height = (doc.height as f64 * scale).round() as u32;
    if width == 0 || height == 0 {
        return std::ptr::null_mut();
    }
    doc.base_mut().resolve(time);
    round_layout_to_device(doc.base_mut(), scale as f32);
    let base = doc.base_mut();
    let mut buffer = render_to_buffer::<ImageBackend, _>(
        |scene| {
            scene.fill(
                Fill::NonZero,
                Default::default(),
                Color::WHITE,
                Default::default(),
                &Rect::new(0.0, 0.0, width as f64, height as f64),
            );
            paint_scene(scene, base, scale, width, height, 0, 0);
        },
        width,
        height,
    );
    // Skia keeps typefaces and glyph strikes in process-wide caches that
    // grow per document; drop them after each paint.
    #[cfg(feature = "skia")]
    skia_safe::graphics::purge_all_caches();
    buffer.shrink_to_fit();
    let len = buffer.len();
    let ptr = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    unsafe {
        *out_width = width;
        *out_height = height;
        *out_len = len;
    }
    ptr
}

/// Paint only the region `x, y, width, height` (CSS pixels of the frame) at
/// `scale` bitmap pixels per CSS pixel: a tile for deep zoom, so a frame can be
/// shown at screen density without rasterising all of it. Switches the
/// document to `scale` (restyling snapped lengths) if it is not there already.
#[unsafe(no_mangle)]
pub extern "C" fn doopblitz_doc_render_region(
    doc: *mut Doc,
    scale: f32,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    out_width: *mut u32,
    out_height: *mut u32,
    out_len: *mut usize,
) -> *mut u8 {
    doopblitz_doc_render_region_at(doc, 0.0, scale, x, y, width, height, out_width, out_height, out_len)
}

/// `doopblitz_doc_render_region` with CSS animations advanced to `time` seconds.
#[unsafe(no_mangle)]
pub extern "C" fn doopblitz_doc_render_region_at(
    doc: *mut Doc,
    time: f64,
    scale: f32,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    out_width: *mut u32,
    out_height: *mut u32,
    out_len: *mut usize,
) -> *mut u8 {
    let (w, h) = unsafe { ((*doc).width, (*doc).height) };
    doopblitz_doc_set_viewport(doc, w, h, scale);
    let doc = unsafe { &mut *doc };
    let _guard = runtime().enter();
    let s = scale as f64;
    let tile_w = (width as f64 * s).round() as u32;
    let tile_h = (height as f64 * s).round() as u32;
    if tile_w == 0 || tile_h == 0 {
        return std::ptr::null_mut();
    }
    let (ox, oy) = ((x as f64 * s).round(), (y as f64 * s).round());
    doc.base_mut().resolve(time);
    round_layout_to_device(doc.base_mut(), scale);
    let base = doc.base_mut();
    let mut buffer = render_to_buffer::<ImageBackend, _>(
        |scene| {
            scene.fill(
                Fill::NonZero,
                Default::default(),
                Color::WHITE,
                Default::default(),
                &Rect::new(0.0, 0.0, tile_w as f64, tile_h as f64),
            );
            paint_scene_region(scene, base, s, tile_w, tile_h, ox, oy);
        },
        tile_w,
        tile_h,
    );
    buffer.shrink_to_fit();
    let len = buffer.len();
    let ptr = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    unsafe {
        *out_width = tile_w;
        *out_height = tile_h;
        *out_len = len;
    }
    ptr
}

#[unsafe(no_mangle)]
pub extern "C" fn doopblitz_buffer_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() {
        drop(unsafe { Vec::from_raw_parts(ptr, len, len) });
    }
}

// ---------------------------------------------------------------------------
// Element selection
//
// Node ids cross the ABI as the raw versioned u64; 0 is the null id.

fn raw(id: Option<NodeId>) -> u64 {
    id.map(NodeId::as_u64).unwrap_or(0)
}

/// The element under a point in CSS pixels, or 0. Text nodes and anonymous
/// boxes resolve to their nearest element.
#[unsafe(no_mangle)]
pub extern "C" fn doopblitz_doc_element_from_point(doc: *mut Doc, x: f32, y: f32) -> u64 {
    let doc = unsafe { &mut *doc };
    let _guard = runtime().enter();
    doc.base_mut().resolve(0.0);
    raw(doc.base().element_from_point(x, y))
}

/// The element a tap at a CSS point selects, or 0, as the web runtime's
/// `probe` picks it: the drawing (`[data-doop-drawing]`) the hit is part of,
/// so a text layer is selected whole rather than the run of bold inside it.
/// Outside a drawing, a hit without a box of its own (inline formatting, whose
/// glyphs live in the parent's inline layout) resolves to the nearest ancestor
/// that has one, or the selection would be an outline of zero size.
#[unsafe(no_mangle)]
pub extern "C" fn doopblitz_doc_pick_from_point(doc: *mut Doc, x: f32, y: f32) -> u64 {
    let doc = unsafe { &mut *doc };
    let _guard = runtime().enter();
    doc.base_mut().resolve(0.0);
    let base = doc.base();
    let Some(hit) = base.element_from_point(x, y) else { return 0 };
    if let Some(drawing) = self_or_ancestor(base, hit, |id| is_drawing(base, id)) {
        return raw(Some(drawing));
    }
    raw(self_or_ancestor(base, hit, |id| has_box(base, id)).or(Some(hit)))
}

fn self_or_ancestor(base: &BaseDocument, id: NodeId, matches: impl Fn(NodeId) -> bool) -> Option<NodeId> {
    let mut current = Some(id);
    while let Some(node) = current {
        if is_real_element(base, node) && matches(node) {
            return Some(node);
        }
        current = element_parent(base, node);
    }
    None
}

fn is_drawing(base: &BaseDocument, id: NodeId) -> bool {
    base.get_node(id)
        .and_then(|n| n.element_data())
        .is_some_and(|e| e.attrs().iter().any(|a| &*a.name.local == "data-doop-drawing"))
}

fn has_box(base: &BaseDocument, id: NodeId) -> bool {
    base.get_node(id).is_some_and(|n| {
        let size = n.final_layout().size;
        size.width > 0.0 && size.height > 0.0
    })
}

/// First element matching a CSS selector, or 0.
#[unsafe(no_mangle)]
pub extern "C" fn doopblitz_doc_query_selector(doc: *const Doc, selector: *const c_char) -> u64 {
    let doc = unsafe { &*doc };
    let selector = unsafe { cstr(selector) };
    raw(doc.base().query_selector(selector).ok().flatten())
}

/// Parent element of a node, or 0 at the root.
#[unsafe(no_mangle)]
pub extern "C" fn doopblitz_node_parent(doc: *const Doc, node: u64) -> u64 {
    let doc = unsafe { &*doc };
    raw(element_parent(doc.base(), NodeId::from_u64(node)))
}

/// Document-relative border box of a node in CSS pixels: `out` receives x, y,
/// width, height. Returns false for an unknown node.
#[unsafe(no_mangle)]
pub extern "C" fn doopblitz_node_rect(doc: *const Doc, node: u64, out: *mut f32) -> bool {
    let doc = unsafe { &*doc };
    let Some(rect) = node_rect(doc.base(), NodeId::from_u64(node)) else { return false };
    unsafe {
        *out = rect[0];
        *out.add(1) = rect[1];
        *out.add(2) = rect[2];
        *out.add(3) = rect[3];
    }
    true
}

/// JSON describing a node for the inspector: tag, id, classes, a unique CSS
/// selector path, a text snippet, parent id and rect. Free with
/// `doopblitz_string_free`. Null for an unknown node.
#[unsafe(no_mangle)]
pub extern "C" fn doopblitz_node_info(doc: *const Doc, node: u64) -> *mut c_char {
    let doc = unsafe { &*doc };
    let base = doc.base();
    let id = NodeId::from_u64(node);
    let Some(element) = base.get_node(id).and_then(|n| n.element_data()) else {
        return std::ptr::null_mut();
    };
    let classes: Vec<&str> = element.attr(local_name!("class")).map(|c| c.split_whitespace().collect()).unwrap_or_default();
    let text: String = base.get_node(id).map(|n| n.text_content()).unwrap_or_default();
    let snippet: String = text.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(120).collect();
    let info = serde_json::json!({
        "id": node,
        "tag": element.name.local.to_string(),
        "idAttr": element.id.as_ref().map(|a| a.to_string()),
        "classes": classes,
        "selector": selector_path(base, id),
        "text": snippet,
        "parent": raw(element_parent(base, id)),
        "rect": node_rect(base, id),
    });
    into_c_string(info.to_string())
}

#[unsafe(no_mangle)]
pub extern "C" fn doopblitz_string_free(ptr: *mut c_char) {
    if !ptr.is_null() {
        drop(unsafe { CString::from_raw(ptr) });
    }
}

fn is_real_element(base: &BaseDocument, id: NodeId) -> bool {
    matches!(base.get_node(id).map(|n| &n.data), Some(NodeData::Element(_)))
}

fn element_parent(base: &BaseDocument, id: NodeId) -> Option<NodeId> {
    let mut current = base.get_node(id)?.parent;
    while let Some(parent) = current {
        if is_real_element(base, parent) {
            return Some(parent);
        }
        current = base.get_node(parent)?.parent;
    }
    None
}

/// Document-relative bounding box of a node's border box as it is drawn: the
/// node's transform and layout offset, and those of each containing block up
/// to the root, are composed into one affine (the mirror of the hit test, which
/// undoes them one by one on the way down) and the box is bounded once, so a
/// child rotated back inside a rotated parent reports its drawn square rather
/// than a bounding box of a bounding box. Blitz keeps transforms in device
/// pixels, so the composition happens at the viewport scale.
fn node_rect(base: &BaseDocument, id: NodeId) -> Option<[f32; 4]> {
    let scale = base.viewport().scale() as f64;
    let size = base.get_node(id)?.final_layout().size;
    let mut to_document = Affine::IDENTITY;
    let mut current = Some(id);
    while let Some(node_id) = current {
        let node = base.get_node(node_id)?;
        let location = node.final_layout().location;
        let scroll = node.scroll_offset();
        let mut local = Affine::translate(((location.x as f64 - scroll.x) * scale, (location.y as f64 - scroll.y) * scale));
        if let Some(transform) = node.transform().as_deref() {
            local *= *transform;
        }
        to_document = local * to_document;
        current = node.containing_block();
    }
    let rect = to_document.transform_rect_bbox(Rect::new(0.0, 0.0, size.width as f64 * scale, size.height as f64 * scale));
    Some([(rect.x0 / scale) as f32, (rect.y0 / scale) as f32, (rect.width() / scale) as f32, (rect.height() / scale) as f32])
}

fn tag_of(base: &BaseDocument, id: NodeId) -> Option<String> {
    base.get_node(id)
        .and_then(|n| n.element_data())
        .filter(|_| is_real_element(base, id))
        .map(|e| e.name.local.to_string())
}

/// `#id` when the element has one, otherwise a `tag:nth-of-type(n)` chain up
/// to the nearest id or the root, matching the selectors doop stores on
/// element comments.
/// `CSS.escape()` for an identifier, so an id such as `a.b` or `1st` becomes a
/// selector that matches that element and nothing else.
fn css_escape(ident: &str) -> String {
    let mut out = String::with_capacity(ident.len() + 4);
    for (i, ch) in ident.chars().enumerate() {
        let code = ch as u32;
        let leading_digit = ch.is_ascii_digit() && (i == 0 || (i == 1 && ident.starts_with('-')));
        if ch == '\0' {
            out.push('\u{FFFD}');
        } else if (0x01..=0x1f).contains(&code) || code == 0x7f || leading_digit {
            out.push_str(&format!("\\{code:x} "));
        } else if i == 0 && ch == '-' && ident.len() == 1 {
            out.push_str("\\-");
        } else if code >= 0x80 || ch == '-' || ch == '_' || ch.is_ascii_alphanumeric() {
            out.push(ch);
        } else {
            out.push('\\');
            out.push(ch);
        }
    }
    out
}

fn selector_path(base: &BaseDocument, id: NodeId) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut current = Some(id);
    while let Some(node_id) = current {
        let Some(node) = base.get_node(node_id) else { break };
        let Some(element) = node.element_data() else { break };
        if !is_real_element(base, node_id) {
            current = node.parent;
            continue;
        }
        let tag = element.name.local.to_string();
        if tag == "html" {
            parts.push(tag);
            break;
        }
        if let Some(attr_id) = element.id.as_ref() {
            parts.push(format!("#{}", css_escape(attr_id)));
            break;
        }
        let parent = element_parent(base, node_id);
        let index = parent
            .and_then(|p| base.get_node(p))
            .map(|p| {
                p.children
                    .iter()
                    .filter(|&&child| tag_of(base, child).as_deref() == Some(tag.as_str()))
                    .position(|&child| child == node_id)
                    .map(|i| i + 1)
                    .unwrap_or(1)
            })
            .unwrap_or(1);
        parts.push(if tag == "body" { tag } else { format!("{tag}:nth-of-type({index})") });
        if parent.is_none() {
            break;
        }
        current = parent;
    }
    parts.reverse();
    parts.join(" > ")
}

#[cfg(test)]
mod tests {
    use super::*;

    const SERVER: &str = "https://doop.design/";

    fn base_of(head: &str) -> String {
        let html = format!("<!doctype html><html><head>{head}</head><body><p>x</p></body></html>");
        Doc::new(&html, SERVER, 100, 100, 1.0).base().base_url().to_string()
    }

    #[test]
    fn an_absolute_base_href_wins_over_the_server() {
        assert_eq!(base_of("<base href='https://www.useterse.ai/'>"), "https://www.useterse.ai/");
        assert_eq!(base_of("<base href='http://example.com/a/b'>"), "http://example.com/a/b");
    }

    #[test]
    fn a_relative_base_href_resolves_against_the_server() {
        assert_eq!(base_of("<base href='/site/'>"), "https://doop.design/site/");
        assert_eq!(base_of("<base href='//cdn.example.com/x/'>"), "https://cdn.example.com/x/");
        assert_eq!(base_of("<base href='  https://www.useterse.ai/  '>"), "https://www.useterse.ai/");
    }

    #[test]
    fn without_a_base_href_the_server_stays() {
        assert_eq!(base_of(""), SERVER);
        assert_eq!(base_of("<base target='_blank'>"), SERVER);
    }

    #[test]
    fn a_base_that_is_not_http_keeps_the_server() {
        for href in ["javascript:alert(1)", "data:text/html,x", "file:///etc/", "about:blank", "http://[::1"] {
            assert_eq!(base_of(&format!("<base href='{href}'>")), SERVER, "{href}");
        }
    }

    #[test]
    fn the_first_base_with_an_href_wins() {
        let head = "<base target='_top'><base href='https://first.example/'><base href='https://second.example/'>";
        assert_eq!(base_of(head), "https://first.example/");
        // A first href that is refused is not passed over for a later one, as in browsers.
        assert_eq!(base_of("<base href='javascript:x'><base href='https://second.example/'>"), SERVER);
    }

    #[test]
    fn replacing_the_html_reads_its_base_again() {
        let mut doc = Doc::new("<p>plain</p>", SERVER, 100, 100, 1.0);
        let set = |doc: &mut Doc, html: &str| {
            let html = CString::new(html).unwrap();
            doopblitz_doc_set_html(doc, html.as_ptr());
            doc.base().base_url().to_string()
        };
        assert_eq!(doc.base().base_url().as_str(), SERVER);
        assert_eq!(set(&mut doc, "<base href='https://a.example/'><p>x</p>"), "https://a.example/");
        assert_eq!(set(&mut doc, "<base href='https://b.example/'><p>x</p>"), "https://b.example/");
        // The server URL is kept, not the last base: a base that goes away no longer applies.
        assert_eq!(set(&mut doc, "<p>x</p>"), SERVER);
        assert_eq!(set(&mut doc, "<base href='/relative/'><p>x</p>"), "https://doop.design/relative/");
    }
}
