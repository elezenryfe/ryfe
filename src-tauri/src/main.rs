// Release builds open no console window; debug builds keep it so `println!`
// and panics are visible while developing.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    ryfe_lib::run()
}
