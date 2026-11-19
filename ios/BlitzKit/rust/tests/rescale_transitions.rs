//! The canvas paints one document at two scales, a base bitmap and a zoomed tile,
//! switching back and forth. A new scale recomputes lengths snapped to device pixels
//! (a 1px border is about 2 CSS px at 0.51 and 1 px at 5.63); that must not start CSS
//! transitions, or every `transition: all` box animates between the two widths and
//! the frame jitters, reporting itself as animating forever.
use std::ffi::CString;

use doopblitz::*;

const W: u32 = 400;
const H: u32 = 300;

fn base(doc: *mut Doc, scale: f32, time: f64) {
    let (mut w, mut h, mut len) = (0u32, 0u32, 0usize);
    doopblitz_doc_set_viewport(doc, W, H, scale);
    let buf = doopblitz_doc_render_at(doc, time, &mut w, &mut h, &mut len);
    doopblitz_buffer_free(buf, len);
}

/// The base bitmap at `scale` and `time`, as RGBA bytes.
fn base_pixels(doc: *mut Doc, scale: f32, time: f64) -> Vec<u8> {
    let (mut w, mut h, mut len) = (0u32, 0u32, 0usize);
    doopblitz_doc_set_viewport(doc, W, H, scale);
    let buf = doopblitz_doc_render_at(doc, time, &mut w, &mut h, &mut len);
    assert!(!buf.is_null());
    let pixels = unsafe { std::slice::from_raw_parts(buf, len) }.to_vec();
    doopblitz_buffer_free(buf, len);
    pixels
}

fn tile(doc: *mut Doc, scale: f32, time: f64) {
    let (mut w, mut h, mut len) = (0u32, 0u32, 0usize);
    let buf = doopblitz_doc_render_region_at(doc, time, scale, 0.0, 0.0, 200.0, 100.0, &mut w, &mut h, &mut len);
    doopblitz_buffer_free(buf, len);
}

fn open(body: &str) -> *mut Doc {
    let html = CString::new(format!("<html><body style=\"margin:0\">{body}</body></html>")).unwrap();
    let url = CString::new("https://doop.design/").unwrap();
    doopblitz_doc_new(html.as_ptr(), url.as_ptr(), W, H, 0.51)
}

#[test]
fn switching_between_base_and_tile_scales_starts_no_transitions() {
    let doc = open(r#"<div style="border:1px solid #000;outline:1px solid #f00;transition:all .3s;padding:8px">Card</div>"#);
    let mut time = 1.0;
    base(doc, 0.51, time);
    assert!(!doopblitz_doc_is_animating(doc), "a static page is not animating");
    for _ in 0..3 {
        time += 0.05;
        tile(doc, 5.63, time);
        assert!(!doopblitz_doc_is_animating(doc), "a tile at a new scale started a transition");
        time += 0.05;
        base(doc, 0.51, time);
        assert!(!doopblitz_doc_is_animating(doc), "the base at its old scale started a transition");
    }
    doopblitz_doc_free(doc);
}

#[test]
fn keyframe_animations_keep_running_across_scale_changes() {
    // Two copies of a spinning page; only `switched` has tiles painted between its
    // base frames. Each base frame must show the animation moved on, and match the
    // copy that never changed scale, so it neither froze nor restarted.
    let page = r#"<style>@keyframes spin{to{transform:rotate(360deg)}}</style><p style="animation:spin 2s linear infinite;margin:100px;font-size:40px">spinning</p>"#;
    let (switched, steady) = (open(page), open(page));
    let mut time = 1.0;
    let mut previous = base_pixels(switched, 0.51, time);
    assert_eq!(previous, base_pixels(steady, 0.51, time));
    assert!(doopblitz_doc_is_animating(switched));
    for _ in 0..3 {
        tile(switched, 5.63, time + 0.05);
        assert!(doopblitz_doc_is_animating(switched), "a scale change stopped a running animation");
        time += 0.1;
        let frame = base_pixels(switched, 0.51, time);
        assert!(doopblitz_doc_is_animating(switched), "a scale change stopped a running animation");
        assert_ne!(frame, previous, "the animation froze across a scale change");
        assert!(frame == base_pixels(steady, 0.51, time), "a scale change restarted or shifted the animation");
        previous = frame;
    }
    doopblitz_doc_free(switched);
    doopblitz_doc_free(steady);
}
