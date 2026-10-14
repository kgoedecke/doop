//! Compare a region tile with the same window of a full render.
//! Usage: tile <html> <w> <h> <scale> <x> <y> <rw> <rh> <out-prefix>
use doopblitz::*;
use std::ffi::CString;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let html = CString::new(std::fs::read_to_string(&a[1]).unwrap()).unwrap();
    let (w, h): (u32, u32) = (a[2].parse().unwrap(), a[3].parse().unwrap());
    let scale: f32 = a[4].parse().unwrap();
    let (x, y, rw, rh): (f32, f32, f32, f32) = (a[5].parse().unwrap(), a[6].parse().unwrap(), a[7].parse().unwrap(), a[8].parse().unwrap());
    let base = CString::new("https://doop.design/").unwrap();
    unsafe {
        let doc = doopblitz_doc_new(html.as_ptr(), base.as_ptr(), w, h, scale);
        let (mut ow, mut oh, mut len) = (0u32, 0u32, 0usize);
        let t = std::time::Instant::now();
        loop {
            let b = doopblitz_doc_render(doc, &mut ow, &mut oh, &mut len);
            doopblitz_buffer_free(b, len);
            if !doopblitz_doc_loading(doc) || t.elapsed().as_secs() > 30 { break; }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        // A fetch that landed between the last paint and the loading check is ingested by the next resolve.
        let warm = doopblitz_doc_render(doc, &mut ow, &mut oh, &mut len);
        doopblitz_buffer_free(warm, len);
        let full = doopblitz_doc_render(doc, &mut ow, &mut oh, &mut len);
        let fpx = std::slice::from_raw_parts(full, len);
        // crop the window from the full render
        let (cx, cy, cw, ch) = ((x * scale) as u32, (y * scale) as u32, (rw * scale) as u32, (rh * scale) as u32);
        let mut crop = Vec::with_capacity((cw * ch * 4) as usize);
        for yy in cy..cy + ch { let row = ((yy * ow + cx) * 4) as usize; crop.extend_from_slice(&fpx[row..row + (cw * 4) as usize]); }
        image::save_buffer(format!("{}.full.png", a[9]), &crop, cw, ch, image::ColorType::Rgba8).unwrap();
        doopblitz_buffer_free(full, len);
        let tile = doopblitz_doc_render_region(doc, scale, x, y, rw, rh, &mut ow, &mut oh, &mut len);
        let tpx = std::slice::from_raw_parts(tile, len);
        image::save_buffer(format!("{}.tile.png", a[9]), tpx, ow, oh, image::ColorType::Rgba8).unwrap();
        let diff = tpx.chunks(4).zip(crop.chunks(4)).filter(|(t, f)| (0..3).any(|i| (t[i] as i32 - f[i] as i32).abs() > 32)).count();
        println!("tile {ow}x{oh}: {diff} of {} pixels differ from the full render", ow * oh);
        doopblitz_buffer_free(tile, len);
        doopblitz_doc_free(doc);
    }
}
