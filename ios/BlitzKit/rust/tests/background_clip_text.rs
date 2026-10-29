//! `background-clip: text` shows the background through transparent text instead of
//! painting it as a box, for blocks and inline elements, with `color` or
//! `-webkit-text-fill-color` making the text transparent.
use doopblitz::*;
use std::ffi::CString;

fn render(body: &str) -> (usize, Vec<u8>) {
    let html = CString::new(format!(
        "<!doctype html><style>body{{margin:0;background:#fff;font:80px/1 sans-serif}}\
         .g{{background:linear-gradient(90deg,#f00,#00f);-webkit-background-clip:text;\
         background-clip:text}}</style>{body}"
    ))
    .unwrap();
    let base = CString::new("https://doop.design/").unwrap();
    let (mut w, mut h, mut len) = (0, 0, 0);
    let doc = doopblitz_doc_new(html.as_ptr(), base.as_ptr(), 400, 100, 1.0);
    let buf = doopblitz_doc_render(doc, &mut w, &mut h, &mut len);
    let pixels = unsafe { std::slice::from_raw_parts(buf, len) }.to_vec();
    doopblitz_buffer_free(buf, len);
    doopblitz_doc_free(doc);
    (w as usize, pixels)
}

/// Pixels painted (not white) and how many of them are reddish or bluish.
fn census((width, pixels): &(usize, Vec<u8>)) -> (usize, usize, usize) {
    let painted: Vec<&[u8]> = pixels
        .chunks(4)
        .filter(|p| p[..3] != [255, 255, 255])
        .collect();
    let red = painted.iter().filter(|p| p[0] > 150 && p[2] < 100).count();
    let blue = painted.iter().filter(|p| p[2] > 150 && p[0] < 100).count();
    let _ = width;
    (painted.len(), red, blue)
}

#[test]
fn gradient_shows_through_transparent_block_text() {
    let (painted, red, blue) = census(&render(
        "<div class='g' style='color:transparent'>MMMM</div>",
    ));
    // Glyphs only: the 400×80 box would paint 32k pixels.
    assert!(
        painted > 1000 && painted < 20_000,
        "{painted} pixels painted"
    );
    assert!(
        red > 100 && blue > 100,
        "gradient not visible: {red} red, {blue} blue"
    );
}

#[test]
fn gradient_shows_through_an_inline_span_with_text_fill_color() {
    let (painted, red, blue) = census(&render(
        "<div><span class='g' style='-webkit-text-fill-color:transparent'>MMMM</span></div>",
    ));
    assert!(
        painted > 1000 && painted < 20_000,
        "{painted} pixels painted"
    );
    assert!(
        red > 100 && blue > 100,
        "gradient not visible: {red} red, {blue} blue"
    );
}

#[test]
fn opaque_text_keeps_its_colour() {
    let (painted, red, blue) = census(&render("<div class='g' style='color:#000'>MMMM</div>"));
    assert!(
        painted > 1000 && painted < 20_000,
        "{painted} pixels painted"
    );
    assert!(
        red < 20 && blue < 20,
        "background showed through opaque text: {red} red, {blue} blue"
    );
}
