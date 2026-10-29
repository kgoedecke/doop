//! Box-shadow blur follows CSS: the blur radius is twice the Gaussian's standard deviation, and
//! it is a length in CSS pixels, so a shadow keeps its look at every zoom.
use doopblitz::*;
use std::ffi::CString;

const HTML: &str = "<!doctype html><body style='margin:0;background:#fff'>\
    <div style='position:absolute;left:100px;top:60px;width:100px;height:100px;background:#fff;\
    box-shadow:0 0 20px 0 #000'></div>";

/// Grey levels at 4, 12 and 20 CSS px outside the box's left edge, at mid height.
fn falloff(scale: f32) -> [u8; 3] {
    let html = CString::new(HTML).unwrap();
    let base = CString::new("https://doop.design/").unwrap();
    let (mut w, mut h, mut len) = (0, 0, 0);
    let doc = doopblitz_doc_new(html.as_ptr(), base.as_ptr(), 300, 220, scale);
    let buf = doopblitz_doc_render(doc, &mut w, &mut h, &mut len);
    let pixels = unsafe { std::slice::from_raw_parts(buf, len) }.to_vec();
    doopblitz_buffer_free(buf, len);
    doopblitz_doc_free(doc);
    let y = (110.0 * scale) as usize;
    [96.0, 88.0, 80.0].map(|x: f32| pixels[(y * w as usize + (x * scale) as usize) * 4])
}

#[test]
fn box_shadow_blur_matches_chrome_at_every_scale() {
    // Chrome paints about 160, 221 and 248 at these points (155, 218, 247 at 0.5x), and the
    // previous blur (no scale, radius taken as the deviation) gave 145, 199 and 225 at 1x.
    for scale in [0.5, 1.0, 2.0] {
        let [near, mid, far] = falloff(scale);
        assert!(near.abs_diff(158) <= 6, "{scale}x: {near} 4px out");
        assert!(mid.abs_diff(220) <= 5, "{scale}x: {mid} 12px out");
        assert!(far.abs_diff(248) <= 4, "{scale}x: {far} 20px out");
    }
}
