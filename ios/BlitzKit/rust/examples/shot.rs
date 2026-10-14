//! Paint one HTML file like the app does (resolve until fetches settle, then
//! one extra paint) and report the centre pixel. Usage: shot <html> <w> <h> <scale> [out.ppm]
use doopblitz::*;
use std::ffi::CString;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let html = CString::new(std::fs::read_to_string(&a[1]).unwrap()).unwrap();
    let (w, h): (u32, u32) = (a[2].parse().unwrap(), a[3].parse().unwrap());
    let scale: f32 = a[4].parse().unwrap();
    let base = CString::new("https://doop.design/").unwrap();
    unsafe {
        let doc = doopblitz_doc_new(html.as_ptr(), base.as_ptr(), w, h, scale);
        let (mut ow, mut oh, mut len) = (0u32, 0u32, 0usize);
        let t = std::time::Instant::now();
        let mut paints = 0;
        let mut buf;
        loop {
            buf = doopblitz_doc_render(doc, &mut ow, &mut oh, &mut len);
            paints += 1;
            let loading = doopblitz_doc_loading(doc);
            println!("paint {paints}: {ow}x{oh} loading={loading} at {:?}", t.elapsed());
            if !loading || t.elapsed().as_secs() > 30 { break; }
            doopblitz_buffer_free(buf, len);
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        doopblitz_buffer_free(buf, len);
        std::thread::sleep(std::time::Duration::from_millis(400));
        buf = doopblitz_doc_render(doc, &mut ow, &mut oh, &mut len);
        let px = std::slice::from_raw_parts(buf, len);
        let i = ((oh / 2) * ow + ow / 2) as usize * 4;
        println!("extra paint: centre pixel rgb {:?}, non-white pixels {}", &px[i..i + 3], px.chunks(4).filter(|p| p[0] < 250 || p[1] < 250 || p[2] < 250).count());
        if let Some(out) = a.get(5) {
            let mut f = std::fs::File::create(out).unwrap();
            use std::io::Write;
            write!(f, "P6\n{ow} {oh}\n255\n").unwrap();
            for p in px.chunks(4) { f.write_all(&p[..3]).unwrap(); }
        }
        doopblitz_buffer_free(buf, len);
        doopblitz_doc_free(doc);
    }
}
