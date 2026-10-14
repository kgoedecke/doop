//! Bounding boxes of runs of a colour in a PNG. Usage: findcolor <png> <r> <g> <b> <tolerance>
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let img = image::open(&a[1]).unwrap().to_rgba8();
    let (r, g, b, tol): (i32, i32, i32, i32) = (a[2].parse().unwrap(), a[3].parse().unwrap(), a[4].parse().unwrap(), a[5].parse().unwrap());
    let (w, h) = img.dimensions();
    let hit = |x: u32, y: u32| { let p = img.get_pixel(x, y); (p[0] as i32 - r).abs() <= tol && (p[1] as i32 - g).abs() <= tol && (p[2] as i32 - b).abs() <= tol };
    // coarse grid of 64px cells that contain the colour
    let mut cells = std::collections::BTreeSet::new();
    for y in 0..h { for x in 0..w { if hit(x, y) { cells.insert((x / 64, y / 64)); } } }
    let mut v: Vec<_> = cells.into_iter().collect();
    v.sort();
    println!("{} cells: {:?}", v.len(), &v[..v.len().min(40)]);
}
