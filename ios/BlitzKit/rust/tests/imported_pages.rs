//! Pages imported from a website: their images resolve against the page's own `<base href>`, and
//! content that fades in with an entry animation shows through the page's reduced-motion fallback.
use doopblitz::*;
use std::ffi::CString;
use std::io::{BufRead, BufReader, Cursor, Write};
use std::net::TcpListener;
use std::time::{Duration, Instant};

const RED: [u8; 3] = [255, 0, 0];
const BLUE: [u8; 3] = [0, 0, 255];

fn png(rgb: [u8; 3]) -> Vec<u8> {
    let image = image::RgbaImage::from_pixel(8, 8, image::Rgba([rgb[0], rgb[1], rgb[2], 255]));
    let mut bytes = Cursor::new(Vec::new());
    image.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
    bytes.into_inner()
}

/// A local stand-in for both servers: `/site/` is the imported website, where the image is
/// red; `/doop/` is the Doop server, which (like the real one) answers a path it does not
/// know with its own HTML page, and here has a blue image so a wrong resolution shows.
fn serve() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (red, blue) = (png(RED), png(BLUE));
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut request_line = String::new();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            if reader.read_line(&mut request_line).is_err() {
                continue;
            }
            loop {
                let mut header = String::new();
                if reader.read_line(&mut header).map_or(true, |n| n == 0) || header == "\r\n" {
                    break;
                }
            }
            let path = request_line.split_whitespace().nth(1).unwrap_or("/");
            let (kind, body) = match path {
                "/site/actors/swatch.png" => ("image/png", red.clone()),
                "/doop/actors/swatch.png" => ("image/png", blue.clone()),
                _ => ("text/html", b"<!doctype html><title>Doop</title>".to_vec()),
            };
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(head.as_bytes()).and_then(|_| stream.write_all(&body));
        }
    });
    port
}

/// Paint `html` served from `base_url` until nothing is loading; the RGB at CSS point (x, y).
fn pixel_after_loading(html: &str, base_url: &str, x: usize, y: usize) -> [u8; 3] {
    let html = CString::new(html).unwrap();
    let base = CString::new(base_url).unwrap();
    let doc = doopblitz_doc_new(html.as_ptr(), base.as_ptr(), 100, 100, 1.0);
    let deadline = Instant::now() + Duration::from_secs(10);
    let (mut w, mut h, mut len) = (0, 0, 0);
    loop {
        doopblitz_buffer_free(doopblitz_doc_render(doc, &mut w, &mut h, &mut len), len);
        if !doopblitz_doc_loading(doc) || Instant::now() > deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    // A fetch can land between the paint and the check; paint once more to take it in.
    let buf = doopblitz_doc_render(doc, &mut w, &mut h, &mut len);
    let pixels = unsafe { std::slice::from_raw_parts(buf, len) }.to_vec();
    doopblitz_buffer_free(buf, len);
    doopblitz_doc_free(doc);
    let i = (y * w as usize + x) * 4;
    [pixels[i], pixels[i + 1], pixels[i + 2]]
}

fn swatch_page(head: &str) -> String {
    format!(
        "<!doctype html><html><head>{head}</head><body style='margin:0'>\
         <img src='actors/swatch.png' style='display:block;width:100px;height:100px'></body></html>"
    )
}

#[test]
fn images_resolve_against_the_pages_own_base() {
    let port = serve();
    let doop = format!("http://127.0.0.1:{port}/doop/");
    let site = format!("http://127.0.0.1:{port}/site/");
    assert_eq!(pixel_after_loading(&swatch_page(&format!("<base href='{site}'>")), &doop, 50, 50), RED);
    // A relative href resolves against the server URL first.
    assert_eq!(pixel_after_loading(&swatch_page("<base href='../site/'>"), &doop, 50, 50), RED);
    // No base, or one that is not http(s): the server URL stays the base.
    assert_eq!(pixel_after_loading(&swatch_page(""), &doop, 50, 50), BLUE);
    assert_eq!(pixel_after_loading(&swatch_page("<base href='javascript:void(0)'>"), &doop, 50, 50), BLUE);
    // Resources requested after the parse (a CSS background, fetched once styles resolve) go
    // to the same base, with or without a `<base>`.
    let background = |head: &str| {
        format!(
            "<!doctype html><html><head>{head}<style>div{{width:100px;height:100px;\
             background:url(actors/swatch.png) 0 0/100% 100%}}</style></head><body style='margin:0'><div></div>"
        )
    };
    assert_eq!(pixel_after_loading(&background(&format!("<base href='{site}'>")), &doop, 50, 50), RED);
    assert_eq!(pixel_after_loading(&background(""), &doop, 50, 50), BLUE);
}

/// One black 100×100 box with `css` applied to `.a`, painted at time 0.
fn box_at_time_zero(css: &str) -> u8 {
    let html = format!(
        "<!doctype html><style>@keyframes rise{{from{{opacity:0}}to{{opacity:1}}}}{css}</style>\
         <body style='margin:0'><div class=a style='width:100px;height:100px;background:#000'></div>"
    );
    let html = CString::new(html).unwrap();
    let base = CString::new("https://doop.design/").unwrap();
    let doc = doopblitz_doc_new(html.as_ptr(), base.as_ptr(), 100, 100, 1.0);
    let (mut w, mut h, mut len) = (0, 0, 0);
    let buf = doopblitz_doc_render_at(doc, 0.0, &mut w, &mut h, &mut len);
    let value = unsafe { std::slice::from_raw_parts(buf, len) }[(50 * w as usize + 50) * 4];
    doopblitz_buffer_free(buf, len);
    doopblitz_doc_free(doc);
    value
}

#[test]
fn frames_match_prefers_reduced_motion_reduce() {
    assert_eq!(box_at_time_zero("@media (prefers-reduced-motion: reduce) { .a { opacity: 0 } }"), 255);
    assert_eq!(box_at_time_zero("@media (prefers-reduced-motion) { .a { opacity: 0 } }"), 255);
    assert_eq!(box_at_time_zero("@media (prefers-reduced-motion: no-preference) { .a { opacity: 0 } }"), 0);
    assert_eq!(box_at_time_zero("@media not (prefers-reduced-motion: reduce) { .a { opacity: 0 } }"), 0);
}

#[test]
fn an_entry_animation_with_a_reduced_motion_fallback_shows_its_content() {
    // As on the imported Terse landing page: content waits at `opacity: 0` for a `forwards`
    // fade-in, which the capture froze at `animation-duration: 0s` (Stylo never starts a
    // zero-length animation, so its end state never applied), and the page's reduced-motion
    // block turns animations off and shows the content.
    let page = ".a { opacity: 0; animation: 0.7s cubic-bezier(0.2, 0.7, 0.2, 1) 0s 1 normal forwards running rise }\
        * { animation-duration: 0s !important; animation-delay: 0s !important }\
        @media (prefers-reduced-motion: reduce) { * { animation: none !important } .a { opacity: 1 } }";
    assert_eq!(box_at_time_zero(page), 0);
}
