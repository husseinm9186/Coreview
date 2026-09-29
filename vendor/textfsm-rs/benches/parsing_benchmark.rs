use criterion::{Criterion, black_box, criterion_group, criterion_main};
use textfsm_rs::TextFSM;

fn benchmark_parsing(c: &mut Criterion) {
    let template_path = "tests/data/cli/cisco_version_template";
    let data_path = "tests/data/cli/cisco_version_example";
    let data = std::fs::read_to_string(data_path).unwrap();

    // Bench 1: Compilation
    c.bench_function("compile cisco version template", |b| {
        b.iter(|| TextFSM::from_file(black_box(template_path)).unwrap())
    });

    // Bench 2: Parsing (Template pre-compiled)
    let mut fsm = TextFSM::from_file(template_path).unwrap();
    c.bench_function("parse cisco version data", |b| {
        b.iter(|| {
            fsm.reset();
            fsm.parse_string(black_box(&data), None).unwrap()
        })
    });

    // Bench 3: Initialization + Parsing (Full cycle)
    c.bench_function("parse cisco version (full)", |b| {
        b.iter(|| {
            let mut fsm = TextFSM::from_file(black_box(template_path)).unwrap();
            fsm.parse_string(black_box(&data), None).unwrap();
        })
    });
}

criterion_group!(benches, benchmark_parsing);
criterion_main!(benches);
