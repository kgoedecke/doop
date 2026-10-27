//! SVG backgrounds must tile in element coordinates, including when painting a zoom tile.
use doopblitz::*;
use std::ffi::CString;
use std::time::{Duration, Instant};

struct Document(*mut Doc);

impl Document {
    fn new(html: &str, scale: f32) -> Self {
        let html = CString::new(html).unwrap();
        let base = CString::new("https://doop.design/").unwrap();
        let doc = Self(doopblitz_doc_new(
            html.as_ptr(),
            base.as_ptr(),
            240,
            160,
            scale,
        ));
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            doc.render();
            if !doopblitz_doc_loading(doc.0) {
                break;
            }
            assert!(Instant::now() < deadline, "data URL did not finish loading");
            std::thread::sleep(Duration::from_millis(5));
        }
        doc
    }

    fn render(&self) -> (usize, Vec<u8>) {
        let (mut w, mut h, mut len) = (0, 0, 0);
        unsafe {
            let buf = doopblitz_doc_render(self.0, &mut w, &mut h, &mut len);
            assert!(!buf.is_null());
            let pixels = std::slice::from_raw_parts(buf, len).to_vec();
            doopblitz_buffer_free(buf, len);
            (w as usize, pixels)
        }
    }
}

impl Drop for Document {
    fn drop(&mut self) {
        doopblitz_doc_free(self.0);
    }
}

const STRIPES: &str = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='20'%3E%3Cpath fill='red' d='M0 0H20V20H0Z'/%3E%3Cpath fill='blue' d='M20 0H40V20H20Z'/%3E%3C/svg%3E";
const NOISE: &str = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='30' height='30'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E";

fn fixture(image: &str, styles: &str) -> String {
    format!(
        "<!doctype html><style>body{{margin:0;background:white}}main{{position:absolute;left:20px;top:30px;width:160px;height:100px}}main::after{{content:'';position:absolute;inset:0;background-image:url(\"{image}\");{styles}}}</style><main></main>"
    )
}

fn rgb(pixels: &[u8], width: usize, x: usize, y: usize) -> &[u8] {
    &pixels[(y * width + x) * 4..][..3]
}

#[test]
fn svg_background_repeat_modes_and_position() {
    for scale in [0.5, 1.0, 2.0] {
        for mode in ["repeat", "repeat-x", "repeat-y", "no-repeat"] {
            let doc = Document::new(
                &fixture(
                    STRIPES,
                    &format!("background-repeat:{mode};background-position:10px 10px"),
                ),
                scale,
            );
            let (w, pixels) = doc.render();
            for y in (5..100).step_by(10) {
                for x in (5..160).step_by(10) {
                    let in_x = mode == "repeat" || mode == "repeat-x" || (10..50).contains(&x);
                    let in_y = mode == "repeat" || mode == "repeat-y" || (10..30).contains(&y);
                    let expected = if !in_x || !in_y {
                        [255, 255, 255]
                    } else if (x + 30) % 40 < 20 {
                        [255, 0, 0]
                    } else {
                        [0, 0, 255]
                    };
                    let at = rgb(
                        &pixels,
                        w,
                        ((20 + x) as f32 * scale) as usize,
                        ((30 + y) as f32 * scale) as usize,
                    );
                    assert_eq!(at, expected, "{mode}, scale {scale}, ({x}, {y})");
                }
            }
            assert_eq!(
                rgb(&pixels, w, (10.0 * scale) as usize, (40.0 * scale) as usize),
                [255; 3]
            );
        }
    }
}

#[test]
fn svg_noise_filter_repeats_instead_of_painting_a_black_square() {
    let doc = Document::new(&fixture(NOISE, "opacity:.5"), 1.0);
    let (w, pixels) = doc.render();
    let mut shades = std::collections::HashSet::new();
    for y in 2..28 {
        for x in 2..28 {
            let first = rgb(&pixels, w, 20 + x, 30 + y);
            shades.insert(first[0]);
            assert_eq!(first, rgb(&pixels, w, 20 + x + 120, 30 + y + 60));
        }
    }
    assert!(
        shades.len() > 10,
        "noise filter produced only {} shades",
        shades.len()
    );
}

#[test]
fn svg_background_region_matches_full_render() {
    for image in [STRIPES, NOISE] {
        let doc = Document::new(&fixture(image, "background-position:7px -3px"), 2.0);
        let (fw, full) = doc.render();
        let (mut w, mut h, mut len) = (0, 0, 0);
        unsafe {
            let buf = doopblitz_doc_render_region(
                doc.0, 2.0, 100.0, 70.0, 60.0, 50.0, &mut w, &mut h, &mut len,
            );
            assert_eq!((w, h), (120, 100));
            let tile = std::slice::from_raw_parts(buf, len);
            for y in 0..h as usize {
                for x in 0..w as usize {
                    assert_eq!(
                        rgb(tile, w as usize, x, y),
                        rgb(&full, fw, 200 + x, 140 + y),
                        "tile pixel ({x}, {y})"
                    );
                }
            }
            doopblitz_buffer_free(buf, len);
        }
    }
}

#[test]
fn svg_background_space_round_and_zero_size() {
    let cases: &[(&str, &[(usize, usize, [u8; 3])])] = &[
        (
            "background-size:60px 20px;background-repeat:space no-repeat",
            &[
                (15, 5, [255, 0, 0]),
                (45, 5, [0, 0, 255]),
                (80, 5, [255; 3]),
                (115, 5, [255, 0, 0]),
                (145, 5, [0, 0, 255]),
                (15, 25, [255; 3]),
            ],
        ),
        (
            "background-size:60px auto;background-repeat:round no-repeat;background-position:center",
            &[
                (10, 5, [255; 3]),
                (10, 50, [255, 0, 0]),
                (40, 50, [0, 0, 255]),
                (65, 50, [255, 0, 0]),
                (95, 50, [0, 0, 255]),
                (10, 95, [255; 3]),
                (10, 35, [255; 3]),
                (10, 65, [255; 3]),
            ],
        ),
        (
            "background-size:400px 300px;background-repeat:round",
            &[(40, 50, [255, 0, 0]), (120, 50, [0, 0, 255])],
        ),
        (
            "background-size:0px 20px",
            &[(5, 5, [255; 3]), (100, 50, [255; 3])],
        ),
        (
            "background-size:40px 0px;background-repeat:round",
            &[(5, 5, [255; 3])],
        ),
    ];
    for (style, probes) in cases {
        let doc = Document::new(&fixture(STRIPES, style), 1.0);
        let (w, pixels) = doc.render();
        for &(x, y, expected) in *probes {
            assert_eq!(
                rgb(&pixels, w, 20 + x, 30 + y),
                expected,
                "{style} at ({x}, {y})"
            );
        }
    }
}

#[test]
fn svg_background_covers_clip_box_and_follows_css_transform() {
    let style = "border:10px solid transparent;padding:10px;background-origin:content-box;\
        transform:translate(10px, 5px) scale(1.5);transform-origin:0 0";
    let doc = Document::new(&fixture(STRIPES, style), 2.0);
    let (w, pixels) = doc.render();
    for (x, expected) in [(5, [0, 0, 255]), (25, [255, 0, 0]), (45, [0, 0, 255])] {
        let px = ((30.0 + x as f32 * 1.5) * 2.0) as usize;
        assert_eq!(rgb(&pixels, w, px, 80), expected, "local x={x}");
    }
    assert_eq!(rgb(&pixels, w, 50, 80), [255; 3]);
}

#[test]
fn tiny_spaced_svg_tiles_are_bounded_but_brush_repeats_still_paint() {
    let solid = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1' height='1'%3E%3Cpath fill='red' d='M0 0H1V1H0Z'/%3E%3C/svg%3E";
    for mode in ["space", "space no-repeat", "repeat", "round"] {
        // Without a work budget the space case emits over two million fills,
        // even though only a small viewport of the element is visible.
        let style =
            format!("width:1080px;height:1920px;background-size:1px 1px;background-repeat:{mode}");
        let doc = Document::new(&fixture(solid, &style), 1.0);
        let (w, pixels) = doc.render();
        let expected = if mode.starts_with("space") {
            [255; 3]
        } else {
            [255, 0, 0]
        };
        assert_eq!(rgb(&pixels, w, 25, 30), expected, "{mode}");
        assert_eq!(rgb(&pixels, w, 155, 30), expected, "{mode}");
    }
}
