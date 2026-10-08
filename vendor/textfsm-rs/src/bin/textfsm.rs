use clap::{Parser, Subcommand, ValueEnum};
use std::path::PathBuf;
use textfsm_rs::{DataRecordConversion, TextFSM};

#[derive(Parser)]
#[command(author, version, about, long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Commands,

    /// Output format
    #[arg(short, long, value_enum, default_value_t = OutputFormat::Yaml, global = true)]
    format: OutputFormat,
}

#[derive(Copy, Clone, PartialEq, Eq, PartialOrd, Ord, ValueEnum)]
enum OutputFormat {
    Json,
    Yaml,
}

#[derive(Subcommand)]
enum Commands {
    /// Parse a file using a specific TextFSM template
    Parse {
        /// Path to the TextFSM template file
        #[arg(short, long)]
        template: PathBuf,

        /// Path to the input data file
        #[arg(short, long)]
        input: PathBuf,

        /// Convert keys to lowercase
        #[arg(short, long)]
        lowercase: bool,
    },
    /// Use CLI Table (ntc-templates index) to parse data
    Auto {
        /// Path to the index file (e.g. ntc_templates/templates/index)
        #[arg(long)]
        index: PathBuf,

        /// Platform name (e.g. cisco_ios)
        #[arg(short, long)]
        platform: String,

        /// Command executed (e.g. "show version")
        #[arg(short, long)]
        command: String,

        /// Path to the input data file
        #[arg(short, long)]
        input: PathBuf,
    },
}

fn main() -> anyhow::Result<()> {
    let matches = clap::Command::new("textfsm")
        .version("0.1.0")
        .author("Author <author@example.com>")
        .about("TextFSM utility")
        .arg(
            clap::Arg::new("template")
                .help("The template file")
                .required(true)
                .index(1),
        )
        .arg(
            clap::Arg::new("input")
                .help("The input file")
                .required(false)
                .index(2),
        )
        .get_matches();

    let template = matches.get_one::<String>("template").unwrap();
    let fsm = TextFSM::from_file(template)?;

    if let Some(input) = matches.get_one::<String>("input") {
        // We need mutable access for parse_file, but parse_reader takes ownership or mutable ref?
        // parse_file takes &mut self.
        // from_file returns a new instance.
        let mut fsm = fsm;
        let results = fsm.parse_file(input, Some(DataRecordConversion::LowercaseKeys))?;
        println!("{}", serde_yaml::to_string(&results)?);
    } else {
        let stdin = std::io::stdin();
        let reader = stdin.lock();
        // parse_reader consumes self.
        let iter = fsm.parse_reader(reader);
        let mut results = Vec::new();
        for record in iter {
            results.push(record?);
        }
        if !results.is_empty() {
            println!("{}", serde_yaml::to_string(&results)?);
        }
    }

    Ok(())
}
