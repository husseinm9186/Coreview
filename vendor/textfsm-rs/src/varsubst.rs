pub use pest::Parser;
use pest::error::Error;
pub use pest::iterators::Pair;
use pest_derive::Parser;

/// A parser for strings containing TextFSM variable substitutions.
///
/// Handles formats like `$VAR`, `${VAR}`, and escaped `$$`.
#[derive(Parser)]
#[grammar = "varsubst.pest"]
pub struct VariableParser;

/// Represents a part of a parsed variable substitution string.
#[derive(Debug, PartialEq)]
pub enum ParseChunk {
    /// A literal dollar sign (escaped `$$`).
    DollarDollar,
    /// A variable reference (e.g., `VAR`).
    Variable(String),
    /// Regular literal text.
    Text(String),
}

impl VariableParser {
    /// Parses a string containing `$` variable substitutions into a list of chunks.
    ///
    /// # Arguments
    /// * `input` - The string to parse.
    ///
    /// # Returns
    /// A vector of `ParseChunk` or a Pest error.
    pub fn parse_dollar_string(input: &str) -> Result<Vec<ParseChunk>, Error<Rule>> {
        let mut out: Vec<ParseChunk> = vec![];
        let pairs = VariableParser::parse(Rule::main, input)?;
        // println!("varsubst input: '{}'", &input);
        for pair in pairs {
            // println!("Rule: {:?}", pair.as_rule());
            for inner_pair in pair.into_inner() {
                match inner_pair.as_rule() {
                    Rule::dollar_dollar => {
                        out.push(ParseChunk::DollarDollar);
                    }
                    Rule::end_dollar => {
                        println!("WARNING: unescaped dollar in the end of line '{}'", &input);
                        out.push(ParseChunk::DollarDollar);
                    }
                    Rule::variable_name => {
                        out.push(ParseChunk::Variable(inner_pair.as_str().to_string()));
                    }
                    Rule::literal => {
                        out.push(ParseChunk::Text(inner_pair.as_str().to_string()));
                    }
                    Rule::EOI => {
                        // success
                    }
                    Rule::WHITESPACE => {
                        out.push(ParseChunk::Text(inner_pair.as_str().to_string()));
                    }
                    x => {
                        return Err(Error::new_from_span(
                            pest::error::ErrorVariant::CustomError {
                                message: format!("Rule {:?} should not happen at varsubst", x),
                            },
                            inner_pair.as_span(),
                        ));
                    }
                }
                /*
                println!(
                    "Inner: {:?} = '{}'",
                    inner_pair.as_rule(),
                    inner_pair.as_str()
                );
                */
            }
        }
        Ok(out)
    }
}
