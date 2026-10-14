//! Memory probe: parse N copies of each HTML file in a directory at a given
//! scale, paint them all twice (first paint, then re-paint after fetches land),
//! and report resident memory. Usage: memory <dir> <copies> <scale>
use doopblitz::*;
use std::ffi::CString;

fn rss_mb() -> f64 {
    let out = std::process::Command::new("ps").args(["-o", "rss=", "-p", &std::process::id().to_string()]).output().unwrap();
    String::from_utf8_lossy(&out.stdout).trim().parse::<f64>().unwrap_or(0.0) / 1024.0
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let dir = &args[1];
    let copies: usize = args[2].parse().unwrap();
    let scale: f32 = args[3].parse().unwrap();
    let base = CString::new("https://doop.design/").unwrap();
    let mut docs = Vec::new();
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().map(|e| e != "html").unwrap_or(true) { continue; }
        let html = CString::new(std::fs::read_to_string(&path).unwrap()).unwrap();
        for _ in 0..copies {
            docs.push(unsafe { doopblitz_doc_new(html.as_ptr(), base.as_ptr(), 1280, 960, scale) });
        }
    }
    println!("{} docs parsed, rss {:.0} MB", docs.len(), rss_mb());
    let (mut w, mut h, mut len) = (0u32, 0u32, 0usize);
    let t = std::time::Instant::now();
    for pass in 0..3 {
        for doc in &docs {
            unsafe {
                let buf = doopblitz_doc_render(*doc, &mut w, &mut h, &mut len);
                doopblitz_buffer_free(buf, len);
            }
        }
        println!("pass {pass}: painted {} docs at {}x{} in {:.2?}, rss {:.0} MB", docs.len(), w, h, t.elapsed(), rss_mb());
        std::thread::sleep(std::time::Duration::from_millis(1500));
    }
    for doc in docs { unsafe { doopblitz_doc_free(doc) } }
    println!("after free: rss {:.0} MB", rss_mb());
}
