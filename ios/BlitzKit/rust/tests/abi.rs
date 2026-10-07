//! Host-side smoke test of the C ABI against a real doop frame.
use std::ffi::{CStr, CString};

use doopblitz::*;

#[test]
fn renders_and_hit_tests_a_real_frame() {
    let html = CString::new(include_str!("terse.html")).unwrap();
    let base = CString::new("https://doop.design/").unwrap();
    unsafe {
        let doc = doopblitz_doc_new(html.as_ptr(), base.as_ptr(), 1512, 1250, 0.5);
        assert!(!doc.is_null());
        assert!(doopblitz_doc_id(doc) > 0 || true);
        let (mut w, mut h, mut len) = (0u32, 0u32, 0usize);
        // Like the app: paint, and paint again whenever fonts or images land,
        // until nothing is pending (the wake callback drives this on device).
        let t = std::time::Instant::now();
        let mut buf = doopblitz_doc_render(doc, &mut w, &mut h, &mut len);
        let mut paints = 1;
        while doopblitz_doc_loading(doc) && t.elapsed().as_secs() < 30 {
            std::thread::sleep(std::time::Duration::from_millis(25));
            doopblitz_buffer_free(buf, len);
            buf = doopblitz_doc_render(doc, &mut w, &mut h, &mut len);
            paints += 1;
        }
        // A fetch can land between the paint and the loading check (the wake
        // callback repaints the app in that case); paint once more to ingest it.
        doopblitz_buffer_free(buf, len);
        buf = doopblitz_doc_render(doc, &mut w, &mut h, &mut len);
        paints += 1;
        eprintln!("render {}x{}: {} paints in {:?}, loading={}", w, h, paints, t.elapsed(), doopblitz_doc_loading(doc));
        assert!(!doopblitz_doc_loading(doc));
        assert_eq!((w, h), (756, 625));
        assert_eq!(len, 756 * 625 * 4);
        // the sidebar is #f5f5f4, so the top-left pixel must not be white
        let px = std::slice::from_raw_parts(buf, 4);
        assert_eq!(&px[..3], &[0xf5, 0xf5, 0xf4]);
        doopblitz_buffer_free(buf, len);

        // "Dashboard" heading sits at about (253, 62) in CSS px
        let hit = doopblitz_doc_element_from_point(doc, 300.0, 62.0);
        assert_ne!(hit, 0);
        let info = doopblitz_node_info(doc, hit);
        let json = CStr::from_ptr(info).to_str().unwrap().to_string();
        doopblitz_string_free(info);
        eprintln!("hit: {json}");
        assert!(json.contains("\"tag\":\"h1\""), "{json}");
        assert!(json.contains("Dashboard"), "{json}");

        let sel = CString::new("main.main h1").unwrap();
        let by_selector = doopblitz_doc_query_selector(doc, sel.as_ptr());
        assert_eq!(by_selector, hit);
        let mut rect = [0f32; 4];
        assert!(doopblitz_node_rect(doc, hit, rect.as_mut_ptr()));
        eprintln!("rect: {rect:?}");
        assert!(rect[0] > 200.0 && rect[0] < 300.0 && rect[1] > 30.0 && rect[1] < 80.0, "{rect:?}");

        // the selector path round-trips through query_selector
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        let path = CString::new(v["selector"].as_str().unwrap()).unwrap();
        assert_eq!(doopblitz_doc_query_selector(doc, path.as_ptr()), hit, "{}", v["selector"]);

        doopblitz_doc_set_viewport(doc, 1512, 1250, 2.0);
        let buf = doopblitz_doc_render(doc, &mut w, &mut h, &mut len);
        assert_eq!((w, h), (3024, 2500));
        doopblitz_buffer_free(buf, len);
        doopblitz_doc_free(doc);
    }
}

#[test]
fn streamed_html_replaces_the_document_and_keeps_geometry() {
    let base = CString::new("https://doop.design/").unwrap();
    let first = CString::new("<!doctype html><html><body style='margin:0;background:#2743ee'><h1 id='a'>One</h1></body></html>").unwrap();
    let second = CString::new("<!doctype html><html><body style='margin:0;background:#e5533c'><p class='x'>Two</p><p class='x'>Three</p></body></html>").unwrap();
    unsafe {
        let doc = doopblitz_doc_new(first.as_ptr(), base.as_ptr(), 200, 100, 1.0);
        let (mut w, mut h, mut len) = (0u32, 0u32, 0usize);
        let buf = doopblitz_doc_render(doc, &mut w, &mut h, &mut len);
        assert_eq!(&std::slice::from_raw_parts(buf, 4)[..3], &[0x27, 0x43, 0xee]);
        doopblitz_buffer_free(buf, len);
        let before = doopblitz_doc_id(doc);

        doopblitz_doc_set_html(doc, second.as_ptr());
        assert_ne!(doopblitz_doc_id(doc), before, "a re-parse gets a new wake id");
        let buf = doopblitz_doc_render(doc, &mut w, &mut h, &mut len);
        assert_eq!((w, h), (200, 100), "size and scale survive set_html");
        assert_eq!(&std::slice::from_raw_parts(buf, 4)[..3], &[0xe5, 0x53, 0x3c]);
        doopblitz_buffer_free(buf, len);

        let sel = CString::new("p.x:nth-of-type(2)").unwrap();
        let third = doopblitz_doc_query_selector(doc, sel.as_ptr());
        assert_ne!(third, 0);
        let info = doopblitz_node_info(doc, third);
        let json = CStr::from_ptr(info).to_str().unwrap().to_string();
        doopblitz_string_free(info);
        assert!(json.contains("\"text\":\"Three\""), "{json}");
        assert!(json.contains("body > p:nth-of-type(2)"), "{json}");
        assert_eq!(doopblitz_node_parent(doc, third), doopblitz_doc_query_selector(doc, CString::new("body").unwrap().as_ptr()));
        doopblitz_doc_free(doc);
    }
}

#[test]
fn several_documents_do_not_bleed_into_each_other() {
    let base = CString::new("https://doop.design/").unwrap();
    let red = CString::new("<!doctype html><html><body style='margin:0;background:#ff0000'><h1>R</h1></body></html>").unwrap();
    let green = CString::new("<!doctype html><html><body style='margin:0;background:#00ff00'><p>G</p></body></html>").unwrap();
    let terse = CString::new(include_str!("terse.html")).unwrap();
    unsafe {
        let a = doopblitz_doc_new(red.as_ptr(), base.as_ptr(), 100, 50, 1.0);
        let b = doopblitz_doc_new(green.as_ptr(), base.as_ptr(), 100, 50, 1.0);
        let c = doopblitz_doc_new(terse.as_ptr(), base.as_ptr(), 1512, 1250, 0.3);
        let (mut w, mut h, mut len) = (0u32, 0u32, 0usize);
        let t = std::time::Instant::now();
        while doopblitz_doc_loading(c) && t.elapsed().as_secs() < 30 {
            std::thread::sleep(std::time::Duration::from_millis(25));
            doopblitz_buffer_free(doopblitz_doc_render(c, &mut w, &mut h, &mut len), len);
        }
        for _ in 0..3 {
            for (doc, rgb) in [(a, [0xffu8, 0, 0]), (b, [0, 0xff, 0]), (c, [0xf5, 0xf5, 0xf4])] {
                let buf = doopblitz_doc_render(doc, &mut w, &mut h, &mut len);
                assert_eq!(&std::slice::from_raw_parts(buf, 4)[..3], &rgb, "doc {doc:?} painted the wrong document");
                doopblitz_buffer_free(buf, len);
            }
        }
        // hit tests stay per document too
        let h1 = doopblitz_doc_query_selector(a, CString::new("h1").unwrap().as_ptr());
        assert_ne!(h1, 0);
        assert_eq!(doopblitz_doc_query_selector(b, CString::new("h1").unwrap().as_ptr()), 0);
        doopblitz_doc_free(b);
        let buf = doopblitz_doc_render(a, &mut w, &mut h, &mut len);
        assert_eq!(&std::slice::from_raw_parts(buf, 4)[..3], &[0xff, 0, 0]);
        doopblitz_buffer_free(buf, len);
        doopblitz_doc_free(a);
        doopblitz_doc_free(c);
    }
}

#[test]
fn sixty_documents_keep_their_own_content() {
    let base = CString::new("https://doop.design/").unwrap();
    let colors = ["#ff0000", "#00ff00", "#0000ff", "#ffff00", "#ff00ff", "#00ffff", "#123456", "#654321"];
    // Inline styles only: the bridge tests must not depend on a font service being reachable.
    let htmls: Vec<CString> = colors.iter().map(|c| CString::new(format!("<!doctype html><html><head><style>body{{margin:0;background:{c}}}</style></head><body><p>{c}</p></body></html>")).unwrap()).collect();
    let expect = |i: usize| -> [u8; 3] { let c = u32::from_str_radix(&colors[i % 8][1..], 16).unwrap(); [(c >> 16) as u8, (c >> 8) as u8, c as u8] };
    unsafe {
        let mut docs = Vec::new();
        for i in 0..60 { docs.push(doopblitz_doc_new(htmls[i % 8].as_ptr(), base.as_ptr(), 100, 50, 0.5)); }
        let ids: std::collections::HashSet<usize> = docs.iter().map(|d| doopblitz_doc_id(*d)).collect();
        assert_eq!(ids.len(), 60, "document ids must be unique");
        let (mut w, mut h, mut len) = (0u32, 0u32, 0usize);
        let t = std::time::Instant::now();
        for (i, doc) in docs.iter().enumerate() {
            loop {
                let buf = doopblitz_doc_render(*doc, &mut w, &mut h, &mut len);
                let px = std::slice::from_raw_parts(buf, 4)[..3].to_vec();
                doopblitz_buffer_free(buf, len);
                if !doopblitz_doc_loading(*doc) || t.elapsed().as_secs() > 60 {
                    // A resource that landed between the paint and the loading check is
                    // ingested by the next resolve: paint once more before judging.
                    let buf = doopblitz_doc_render(*doc, &mut w, &mut h, &mut len);
                    let px = std::slice::from_raw_parts(buf, 4)[..3].to_vec();
                    doopblitz_buffer_free(buf, len);
                    assert_eq!(px, expect(i), "doc {i} painted the wrong content");
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
        }
        // free every other document, re-create it, and check again (slot reuse)
        for i in (0..60).step_by(2) { doopblitz_doc_free(docs[i]); docs[i] = doopblitz_doc_new(htmls[i % 8].as_ptr(), base.as_ptr(), 100, 50, 0.5); }
        for (i, doc) in docs.iter().enumerate() {
            loop {
                let buf = doopblitz_doc_render(*doc, &mut w, &mut h, &mut len);
                let px = std::slice::from_raw_parts(buf, 4)[..3].to_vec();
                doopblitz_buffer_free(buf, len);
                if !doopblitz_doc_loading(*doc) || t.elapsed().as_secs() > 90 {
                    let buf = doopblitz_doc_render(*doc, &mut w, &mut h, &mut len);
                    let px = std::slice::from_raw_parts(buf, 4)[..3].to_vec();
                    doopblitz_buffer_free(buf, len);
                    assert_eq!(px, expect(i), "doc {i} painted the wrong content after reuse");
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
        }
        for doc in docs { doopblitz_doc_free(doc); }
    }
}

#[test]
fn rescaling_restyles_device_pixel_snapped_borders() {
    // A frame first styled at a tiny scale (fitted board) and then zoomed in must
    // match a frame created at the final scale: hairline borders snap to one device
    // pixel at cascade time, so the rescale has to recascade.
    let base = CString::new("https://doop.design/").unwrap();
    let html = CString::new("<!doctype html><html><body style='margin:0;background:#fff'>\
        <div style='margin:20px;width:300px;height:120px;border:1px solid #000;outline:1.5px solid #27f;outline-offset:4px'></div>\
        <button style='margin:20px;padding:10px 20px;border:1px solid #000;background:#fff'>Start</button></body></html>").unwrap();
    unsafe {
        let zoomed = doopblitz_doc_new(html.as_ptr(), base.as_ptr(), 400, 240, 0.09);
        let fresh = doopblitz_doc_new(html.as_ptr(), base.as_ptr(), 400, 240, 0.84);
        let (mut w, mut h, mut len) = (0u32, 0u32, 0usize);
        doopblitz_buffer_free(doopblitz_doc_render(zoomed, &mut w, &mut h, &mut len), len);
        doopblitz_doc_set_viewport(zoomed, 400, 240, 0.84);
        let a = doopblitz_doc_render(zoomed, &mut w, &mut h, &mut len);
        let (aw, ah, alen) = (w, h, len);
        let b = doopblitz_doc_render(fresh, &mut w, &mut h, &mut len);
        assert_eq!((aw, ah), (w, h));
        let pa = std::slice::from_raw_parts(a, alen);
        let pb = std::slice::from_raw_parts(b, len);
        let dark = |p: &[u8]| p[0] < 128;
        let dark_a = pa.chunks(4).filter(|p| dark(p)).count();
        let dark_b = pb.chunks(4).filter(|p| dark(p)).count();
        eprintln!("dark pixels after rescale {dark_a}, fresh {dark_b}");
        // Thick snapped borders would roughly multiply the dark pixel count.
        assert!((dark_a as f64) < (dark_b as f64) * 1.3 + 50.0, "rescaled frame draws {dark_a} dark px vs {dark_b} fresh");
        doopblitz_buffer_free(a, alen);
        doopblitz_buffer_free(b, len);
        doopblitz_doc_free(zoomed);
        doopblitz_doc_free(fresh);
    }
}

#[test]
fn region_render_matches_the_full_render() {
    let base = CString::new("https://doop.design/").unwrap();
    let html = CString::new("<!doctype html><html><body style='margin:0;background:#fff'>\
        <div style='position:absolute;left:100px;top:60px;width:200px;height:80px;background:#27f'></div>\
        <p style='position:absolute;left:120px;top:160px;font:20px sans-serif'>Tile me</p></body></html>").unwrap();
    unsafe {
        let doc = doopblitz_doc_new(html.as_ptr(), base.as_ptr(), 400, 240, 2.0);
        let (mut w, mut h, mut len) = (0u32, 0u32, 0usize);
        let full = doopblitz_doc_render(doc, &mut w, &mut h, &mut len);
        let (fw, flen) = (w as usize, len);
        let full_px = std::slice::from_raw_parts(full, flen).to_vec();
        // A window far from the origin: content beyond the tile's own size must not be culled.
        let tile = doopblitz_doc_render_region(doc, 2.0, 230.0, 130.0, 120.0, 70.0, &mut w, &mut h, &mut len);
        assert_eq!((w, h), (240, 140));
        let tile_px = std::slice::from_raw_parts(tile, len);
        let mut mismatches = 0;
        for ty in 0..h as usize {
            for tx in 0..w as usize {
                let t = &tile_px[(ty * w as usize + tx) * 4..][..3];
                let f = &full_px[((ty + 260) * fw + tx + 460) * 4..][..3];
                if t != f { mismatches += 1; }
            }
        }
        assert!(mismatches < 50, "{mismatches} pixels differ between the tile and the full render");
        doopblitz_buffer_free(tile, len);
        doopblitz_buffer_free(full, flen);
        doopblitz_doc_free(doc);
    }
}

/// Taffy rounds layout to whole CSS pixels; at a paint scale above 1 that put a
/// different number of device pixels on each side of a box sitting on a half
/// pixel. The bridge re-rounds on the device grid, so the two sides differ by at
/// most one device pixel, as in a browser.
#[test]
fn borders_on_half_pixels_stay_symmetric_at_high_scale() {
    let html = CString::new(
        r#"<div style="position:absolute;left:10.5px;top:10.5px;width:9px;height:9px;border:1.5px solid #000;background:#fff"></div>"#,
    )
    .unwrap();
    let base = CString::new("https://doop.design/").unwrap();
    unsafe {
        let doc = doopblitz_doc_new(html.as_ptr(), base.as_ptr(), 60, 60, 3.0);
        let (mut w, mut h, mut len) = (0u32, 0u32, 0usize);
        let px = doopblitz_doc_render(doc, &mut w, &mut h, &mut len);
        assert_eq!((w, h), (180, 180));
        let pixels = std::slice::from_raw_parts(px, len);
        // Walk the row through the middle of the box and measure the dark runs.
        let y = ((10.5 + 4.5 + 1.5) * 3.0) as usize;
        let dark = |x: usize| pixels[(y * w as usize + x) * 4] < 128;
        let mut runs = Vec::new();
        let mut x = 0;
        while x < w as usize {
            if dark(x) {
                let start = x;
                while x < w as usize && dark(x) {
                    x += 1;
                }
                runs.push(x - start);
            } else {
                x += 1;
            }
        }
        assert_eq!(runs.len(), 2, "expected a left and a right border, got runs {runs:?}");
        assert!(runs[0] >= 3 && runs[1] >= 3, "borders too thin: {runs:?}");
        assert!((runs[0] as i32 - runs[1] as i32).abs() <= 1, "borders differ by more than a device pixel: {runs:?}");
        doopblitz_buffer_free(px, len);
        doopblitz_doc_free(doc);
    }
}

/// An element id with CSS-special characters must come back as a selector that
/// matches that element, as `CSS.escape()` would build it.
#[test]
fn selector_paths_escape_ids() {
    let html = CString::new(r#"<div id="a.b"><span id="1st">x</span></div><p class="b">y</p>"#).unwrap();
    let base = CString::new("https://doop.design/").unwrap();
    unsafe {
        let doc = doopblitz_doc_new(html.as_ptr(), base.as_ptr(), 100, 100, 1.0);
        let (mut w, mut h, mut len) = (0u32, 0u32, 0usize);
        doopblitz_buffer_free(doopblitz_doc_render(doc, &mut w, &mut h, &mut len), len);
        for (selector, expected) in [("#a\\.b", "#a\\.b"), ("#\\31 st", "#\\31 st")] {
            let node = doopblitz_doc_query_selector(doc, CString::new(selector).unwrap().as_ptr());
            assert_ne!(node, 0, "{selector} should match");
            let raw = doopblitz_node_info(doc, node);
            let info = CStr::from_ptr(raw).to_str().unwrap().to_string();
            doopblitz_string_free(raw);
            assert!(info.contains(&format!("\"selector\":\"{}\"", expected.replace('\\', "\\\\"))), "info was {info}");
        }
        doopblitz_doc_free(doc);
    }
}

/// A `background-attachment: fixed` layer is sized against the whole frame, so a
/// tile of it must match the same window of a full render rather than squeezing
/// the gradient into the tile.
#[test]
fn tiles_keep_fixed_backgrounds_sized_to_the_frame() {
    let html = CString::new(
        "<!doctype html><html><body style='margin:0;min-height:100vh;background:linear-gradient(90deg,#ff0000,#0000ff) fixed'></body></html>",
    )
    .unwrap();
    let base = CString::new("https://doop.design/").unwrap();
    unsafe {
        let doc = doopblitz_doc_new(html.as_ptr(), base.as_ptr(), 400, 200, 1.0);
        let (mut w, mut h, mut len) = (0u32, 0u32, 0usize);
        let full = doopblitz_doc_render(doc, &mut w, &mut h, &mut len);
        assert_eq!((w, h), (400, 200));
        let full_px = std::slice::from_raw_parts(full, len).to_vec();
        doopblitz_buffer_free(full, len);
        let (mut tw, mut th, mut tlen) = (0u32, 0u32, 0usize);
        let tile = doopblitz_doc_render_region(doc, 1.0, 300.0, 50.0, 100.0, 100.0, &mut tw, &mut th, &mut tlen);
        assert_eq!((tw, th), (100, 100));
        let tile_px = std::slice::from_raw_parts(tile, tlen);
        let mut mismatches = 0;
        for y in 0..100usize {
            for x in 0..100usize {
                let t = &tile_px[(y * 100 + x) * 4..][..3];
                let f = &full_px[((y + 50) * 400 + x + 300) * 4..][..3];
                if t.iter().zip(f).any(|(a, b)| (*a as i32 - *b as i32).abs() > 8) {
                    mismatches += 1;
                }
            }
        }
        assert_eq!(mismatches, 0, "tile of a fixed gradient differs from the full render in {mismatches} pixels");
        doopblitz_buffer_free(tile, tlen);
        doopblitz_doc_free(doc);
    }
}
