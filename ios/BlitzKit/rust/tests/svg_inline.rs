//! Inline SVG is drawn from standalone markup, so what the cascade decides (author CSS, `var()`,
//! `currentColor`) and what other `<svg>` elements define (icon sprites, gradients, filters) must
//! be carried into it. Each case paints a 100×100 frame and samples its centre.
use doopblitz::*;
use std::ffi::CString;

fn centre(html: &str) -> [u8; 3] {
    pixel(html, 50, 50)
}

fn pixel(html: &str, x: usize, y: usize) -> [u8; 3] {
    let html = CString::new(format!(
        "<!doctype html><body style='margin:0;background:white'>{html}"
    ))
    .unwrap();
    let base = CString::new("https://doop.design/").unwrap();
    let (mut w, mut h, mut len) = (0, 0, 0);
    unsafe {
        let doc = doopblitz_doc_new(html.as_ptr(), base.as_ptr(), 100, 100, 1.0);
        let buf = doopblitz_doc_render(doc, &mut w, &mut h, &mut len);
        let pixels = std::slice::from_raw_parts(buf, len);
        let at = (y * w as usize + x) * 4;
        let rgb = [pixels[at], pixels[at + 1], pixels[at + 2]];
        doopblitz_buffer_free(buf, len);
        doopblitz_doc_free(doc);
        rgb
    }
}

const RED: [u8; 3] = [255, 0, 0];
const BLUE: [u8; 3] = [0, 0, 255];
const WHITE: [u8; 3] = [255, 255, 255];

const SPRITE: &str = "<svg width='0' height='0' style='position:absolute'><defs>\
    <linearGradient id='g'><stop offset='0' stop-color='red'/><stop offset='1' stop-color='red'/></linearGradient>\
    <symbol id='dot' viewBox='0 0 100 100'><circle cx='50' cy='50' r='40' style='fill:var(--dot,red)'/></symbol>\
    <symbol id='ring' viewBox='0 0 100 100'><circle class='ring' cx='50' cy='50' r='30'/></symbol>\
    <symbol id='bar' viewBox='0 0 100 100'><rect width='100' height='100' fill='url(#g)'/></symbol>\
    <rect id='half' width='40' height='100' fill='blue'/>\
    <symbol id='loop' viewBox='0 0 100 100'><use href='#loop'/><rect width='100' height='100' fill='red'/></symbol>\
    </defs></svg>";

#[test]
fn author_css_overrides_presentation_attributes() {
    let html = "<style>.c{fill:red}</style><svg width='100' height='100'><circle class='c' cx='50' cy='50' r='40' fill='blue'/></svg>";
    assert_eq!(centre(html), RED);
}

#[test]
fn presentation_attributes_still_paint() {
    let html = "<svg width='100' height='100'><circle cx='50' cy='50' r='40' fill='blue'/></svg>";
    assert_eq!(centre(html), BLUE);
}

#[test]
fn custom_properties_resolve_in_inline_style() {
    let html = "<svg width='100' height='100' style='--x:red'><circle cx='50' cy='50' r='40' style='fill:var(--x,blue)'/></svg>";
    assert_eq!(centre(html), RED);
}

#[test]
fn stroke_properties_from_css_reach_the_path() {
    // A 30px current-colour stroke along y=50; without the CSS it is a 1px black line.
    let html = "<style>.l{fill:none;stroke:currentColor;stroke-width:30}</style>\
        <svg width='100' height='100' viewBox='0 0 100 100' style='color:red'><path class='l' d='M0 50H100'/></svg>";
    assert_eq!(pixel(html, 50, 40), RED);
}

#[test]
fn use_resolves_a_symbol_in_another_svg() {
    let html = format!("{SPRITE}<svg width='100' height='100'><use href='#dot'/></svg>");
    assert_eq!(centre(&html), RED);
}

#[test]
fn use_content_inherits_from_the_use_site() {
    let html = format!(
        "{SPRITE}<svg width='100' height='100' style='--dot:blue'><use href='#dot'/></svg>"
    );
    assert_eq!(centre(&html), BLUE);
    let html = format!(
        "<style>.ring{{fill:none;stroke:currentColor;stroke-width:40}}</style>{SPRITE}\
        <svg width='100' height='100' style='color:blue'><use href='#ring'/></svg>"
    );
    assert_eq!(pixel(&html, 50, 20), BLUE);
}

#[test]
fn use_brings_paint_servers_from_another_svg() {
    let html = format!("{SPRITE}<svg width='100' height='100'><use href='#bar'/></svg>");
    assert_eq!(centre(&html), RED);
}

#[test]
fn use_offsets_by_x_and_accepts_xlink_href() {
    let html =
        format!("{SPRITE}<svg width='100' height='100'><use xlink:href='#half' x='60'/></svg>");
    assert_eq!(pixel(&html, 50, 50), WHITE);
    assert_eq!(pixel(&html, 80, 50), BLUE);
}

#[test]
fn display_none_hides_svg_content() {
    let html = "<style>.hide{display:none}</style><svg width='100' height='100'>\
        <rect width='100' height='100' fill='blue'/><rect class='hide' width='100' height='100' fill='red'/></svg>";
    assert_eq!(centre(html), BLUE);
}

#[test]
fn filtered_inline_svg_keeps_its_filter() {
    // anyrender_svg drops filters; flooding the rect red only shows through resvg.
    let html = "<svg width='100' height='100'><filter id='f'><feFlood flood-color='red'/></filter>\
        <rect width='100' height='100' fill='blue' filter='url(#f)'/></svg>";
    assert_eq!(centre(html), RED);
}

#[test]
fn circular_use_renders_the_rest_of_the_symbol() {
    let html = format!("{SPRITE}<svg width='100' height='100'><use href='#loop'/></svg>");
    assert_eq!(centre(&html), RED);
}

#[test]
fn gradients_from_inline_style_and_css_survive() {
    let defs = "<defs><linearGradient id='g'><stop offset='0' stop-color='red'/>\
        <stop offset='1' stop-color='red'/></linearGradient></defs>";
    let inline = format!(
        "<svg width='100' height='100'>{defs}<rect width='100' height='100' style='fill:url(#g)'/></svg>"
    );
    assert_eq!(centre(&inline), RED);
    let css = format!(
        "<style>.g{{fill:url(#g)}}</style><svg width='100' height='100'>{defs}\
         <rect class='g' width='100' height='100'/></svg>"
    );
    assert_eq!(centre(&css), RED);
}

#[test]
fn opacity_attribute_and_css_opacity_together_still_paint() {
    // Two `opacity` attributes made the SVG invalid XML, so nothing painted.
    let html = "<svg width='100' height='100'><rect width='100' height='100' fill='red' \
        opacity='0.9' style='opacity:0.5'/></svg>";
    let [r, g, b] = centre(html);
    assert_eq!(r, 255);
    assert!((110..=145).contains(&g) && g == b, "{:?}", [r, g, b]);
}

#[test]
fn id_rules_style_use_clones() {
    let html = format!(
        "<style>#half{{fill:red}}</style>{SPRITE}<svg width='100' height='100'><use href='#half' x='40'/></svg>"
    );
    assert_eq!(pixel(&html, 60, 50), RED);
}
