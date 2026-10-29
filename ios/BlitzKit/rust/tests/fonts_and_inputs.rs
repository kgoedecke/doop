//! Web fonts (variable weights, inline SVG text), input placeholders and the loading flag.
//! Fonts come from macOS's own variable fonts through `file:` URLs, so the tests need no
//! network; they run on the macOS CI runner.
use doopblitz::*;
use std::ffi::CString;
use std::time::{Duration, Instant};

/// SF Pro: `wght` 1..1000 with its default at 400 and an `avar` table.
const SF: &str = "file:///System/Library/Fonts/SFNS.ttf";
/// New York, a serif, so a fallback to a sans-serif system font shows.
const NEW_YORK: &str = "file:///System/Library/Fonts/NewYork.ttf";

struct Frame {
    width: usize,
    pixels: Vec<u8>,
}

impl Frame {
    /// Paint `body` at 1× until every font and image has arrived and been applied.
    fn paint(width: u32, height: u32, body: &str) -> Self {
        let html = CString::new(format!(
            "<!doctype html><body style='margin:0;background:white'>{body}"
        ))
        .unwrap();
        let base = CString::new("https://doop.design/").unwrap();
        let doc = doopblitz_doc_new(html.as_ptr(), base.as_ptr(), width, height, 1.0);
        let deadline = Instant::now() + Duration::from_secs(10);
        let frame = loop {
            let frame = Self::render(doc);
            if !doopblitz_doc_loading(doc) {
                break frame;
            }
            assert!(
                Instant::now() < deadline,
                "resources did not finish loading"
            );
            std::thread::sleep(Duration::from_millis(10));
        };
        doopblitz_doc_free(doc);
        frame
    }

    fn render(doc: *mut Doc) -> Self {
        let (mut w, mut h, mut len) = (0, 0, 0);
        unsafe {
            let buf = doopblitz_doc_render(doc, &mut w, &mut h, &mut len);
            let pixels = std::slice::from_raw_parts(buf, len).to_vec();
            doopblitz_buffer_free(buf, len);
            Self {
                width: w as usize,
                pixels,
            }
        }
    }

    fn rgb(&self, x: usize, y: usize) -> [u8; 3] {
        let at = (y * self.width + x) * 4;
        [self.pixels[at], self.pixels[at + 1], self.pixels[at + 2]]
    }

    /// Pixels at least half dark, within rows `rows`.
    fn ink(&self, rows: std::ops::Range<usize>) -> usize {
        rows.flat_map(|y| (0..self.width).map(move |x| (x, y)))
            .filter(|&(x, y)| self.rgb(x, y)[0] < 128)
            .count()
    }

    /// Horizontal extent of the dark pixels within rows `rows`.
    fn ink_span(&self, rows: std::ops::Range<usize>) -> Option<(usize, usize)> {
        let columns: Vec<usize> = (0..self.width)
            .filter(|&x| rows.clone().any(|y| self.rgb(x, y)[0] < 128))
            .collect();
        Some((*columns.first()?, *columns.last()?))
    }
}

#[test]
fn variable_font_weights_get_heavier_in_order() {
    let face = format!("<style>@font-face{{font-family:Var;src:url({SF})}}</style>");
    let ink: Vec<usize> = [100, 400, 700, 1000]
        .iter()
        .map(|weight| {
            Frame::paint(
                400,
                60,
                &format!("{face}<div style='font:{weight} 40px Var'>Hamburg</div>"),
            )
            .ink(0..60)
        })
        .collect();
    assert!(
        ink.windows(2).all(|pair| pair[0] < pair[1]),
        "ink by weight 100/400/700/1000: {ink:?}"
    );
    // Below the axis default, weights were interpolated from the wrong end (100 drew like 400).
    assert!(ink[0] * 10 < ink[1] * 8, "ink by weight: {ink:?}");
}

#[test]
fn inline_svg_text_uses_the_pages_web_fonts() {
    let svg = |faces: &str, family: &str| {
        Frame::paint(
            500,
            60,
            &format!(
                "<style>{faces}</style><svg width='500' height='60'><text x='0' y='45' \
                 font-family='{family}' font-size='40'>Hamburgefonts</text></svg>"
            ),
        )
        .pixels
    };
    let latin =
        format!("@font-face{{font-family:Web;src:url({NEW_YORK});unicode-range:U+0000-00FF}}");
    // A subset that does not cover Latin, as Google Fonts serves one per script.
    let decoy = format!("@font-face{{font-family:Web;src:url({SF});unicode-range:U+0400-045F}}");
    let web = svg(&latin, "Web");
    assert_ne!(web, svg("", "Web"), "SVG text ignored the @font-face font");
    assert_eq!(
        web,
        svg(&format!("{decoy}{latin}"), "Web"),
        "SVG text drew with a non-Latin subset"
    );
}

#[test]
fn inline_svg_text_inherits_the_page_font_and_letter_spacing() {
    let face = format!("<style>@font-face{{font-family:Web;src:url({NEW_YORK})}}</style>");
    let spaced = |spacing: &str| {
        let frame = Frame::paint(
            500,
            60,
            &format!(
                "{face}<div style='font:30px Web;letter-spacing:{spacing}'>\
                 <svg width='500' height='60'><text x='0' y='40'>SPACED</text></svg></div>"
            ),
        );
        let (start, end) = frame.ink_span(0..60).unwrap();
        end - start
    };
    let (normal, wide) = (spaced("0"), spaced("10px"));
    // Five gaps of 10px; the default 12px Times would be far narrower than 30px New York.
    assert!(wide >= normal + 45, "unspaced {normal}px, spaced {wide}px");
    assert!(
        normal > 100,
        "SVG text did not inherit the 30px page font: {normal}px"
    );
}

#[test]
fn empty_inputs_show_their_placeholder() {
    let field = "display:block;width:300px;height:40px;margin:0;padding:0 8px;border:0;font:20px sans-serif";
    let shown = Frame::paint(
        320,
        40,
        &format!("<input placeholder='Your email address' style='{field}'>"),
    );
    let grey = (0..320)
        .flat_map(|x| (0..40).map(move |y| (x, y)))
        .any(|(x, y)| {
            let [r, g, b] = shown.rgb(x, y);
            r == g && g == b && (100..140).contains(&r)
        });
    assert!(grey, "no #757575 placeholder text");

    let styled = Frame::paint(
        320,
        40,
        &format!(
            "<style>input::placeholder{{color:rgb(255,0,0)}}</style>\
             <input placeholder='Your email address' style='{field}'>"
        ),
    );
    let red = (0..320)
        .flat_map(|x| (0..40).map(move |y| (x, y)))
        .any(|(x, y)| styled.rgb(x, y) == [255, 0, 0]);
    assert!(red, "::placeholder colour not applied");

    let filled = Frame::paint(
        320,
        40,
        &format!("<input value='a' placeholder='Your email address' style='{field}'>"),
    );
    let blank = Frame::paint(320, 40, &format!("<input value='a' style='{field}'>"));
    assert_eq!(
        filled.pixels, blank.pixels,
        "placeholder drawn over a value"
    );
}

#[test]
fn loading_covers_resources_found_in_a_loaded_stylesheet() {
    // The stylesheet's font is only requested once the stylesheet itself has been applied; the
    // flag must not read idle in between, or the frame is left painted with the fallback font.
    let css = format!(
        "data:text/css,@font-face%7Bfont-family:Late;src:url({NEW_YORK})%7Ddiv%7Bfont:40px Late%7D"
    );
    let late = Frame::paint(
        500,
        60,
        &format!("<link rel='stylesheet' href='{css}'><div>Hamburgefonts</div>"),
    );
    let direct = Frame::paint(
        500,
        60,
        &format!(
            "<style>@font-face{{font-family:Late;src:url({NEW_YORK})}}div{{font:40px Late}}</style>\
             <div>Hamburgefonts</div>"
        ),
    );
    assert_eq!(late.ink_span(0..60), direct.ink_span(0..60));
}

#[test]
fn textarea_placeholder_keeps_its_line_breaks() {
    let area = "display:block;width:300px;height:80px;margin:0;padding:0;border:0;\
                font:20px/30px sans-serif;resize:none";
    let frame = Frame::paint(
        320,
        80,
        &format!("<textarea placeholder='first&#10;second' style='{area}'></textarea>"),
    );
    let grey = |rows: std::ops::Range<usize>| {
        rows.flat_map(|y| (0..320).map(move |x| (x, y)))
            .any(|(x, y)| {
                let [r, g, b] = frame.rgb(x, y);
                r == g && g == b && r < 200
            })
    };
    assert!(grey(0..30) && grey(30..60), "placeholder not on two lines");
}

#[test]
fn long_textarea_placeholder_wraps_at_the_field_width() {
    let area = "display:block;width:120px;height:80px;margin:0;padding:0;border:0;\
                font:20px/30px sans-serif;resize:none";
    let frame = Frame::paint(
        320,
        80,
        &format!("<textarea placeholder='one two three four five six' style='{area}'></textarea>"),
    );
    let ink_in = |rows: std::ops::Range<usize>, columns: std::ops::Range<usize>| {
        rows.flat_map(|y| columns.clone().map(move |x| (x, y)))
            .any(|(x, y)| frame.rgb(x, y)[0] < 200)
    };
    assert!(
        ink_in(30..60, 0..120),
        "placeholder did not wrap onto a second line"
    );
    assert!(!ink_in(0..80, 125..320), "placeholder ran past the field");
}

#[test]
fn placeholder_takes_a_web_font_that_loads_later() {
    let field = "display:block;width:400px;height:40px;margin:0;padding:0;border:0;\
                 font:30px Web,sans-serif";
    let input = format!("<input placeholder='Hamburgefonts' style='{field}'>");
    let with_font = Frame::paint(
        420,
        40,
        &format!("<style>@font-face{{font-family:Web;src:url({NEW_YORK})}}</style>{input}"),
    );
    let fallback = Frame::paint(420, 40, &input);
    assert_ne!(with_font.ink_span(0..40), fallback.ink_span(0..40));
}
