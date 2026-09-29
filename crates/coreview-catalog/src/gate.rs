//! Gate expressions: `always`, `cap.vrf`, `role.firewall`, `a && b`,
//! `a || b`, `!a`, parentheses. Evaluated against what the probes found;
//! a flag nobody set is false, a role nobody assigned matches nothing.

use std::collections::{BTreeMap, BTreeSet};

use thiserror::Error;

/// What is known about a device when the plan is built.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Facts {
    /// Capability flags the probes (or the role defaults) set.
    pub caps: BTreeSet<String>,
    /// The derived role, after the operator's override if any.
    pub role: Option<String>,
    /// Names to expand `foreach` over: `vrf` → the VRFs, `vdom` → the VDOMs, …
    pub contexts: BTreeMap<String, Vec<String>>,
}

impl Facts {
    pub fn with_caps<I: IntoIterator<Item = S>, S: Into<String>>(caps: I) -> Self {
        Facts { caps: caps.into_iter().map(Into::into).collect(), ..Default::default() }
    }
    pub fn role(mut self, role: &str) -> Self {
        self.role = Some(role.to_string());
        self
    }
    pub fn context<I: IntoIterator<Item = S>, S: Into<String>>(mut self, kind: &str, names: I) -> Self {
        self.contexts.insert(kind.to_string(), names.into_iter().map(Into::into).collect());
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Gate {
    Always,
    Cap(String),
    Role(String),
    Not(Box<Gate>),
    And(Box<Gate>, Box<Gate>),
    Or(Box<Gate>, Box<Gate>),
}

#[derive(Debug, Error, PartialEq, Eq)]
#[error("gate {0:?}: {1}")]
pub struct GateError(pub String, pub String);

impl Gate {
    pub fn parse(text: &str) -> Result<Gate, GateError> {
        let tokens = tokenize(text).map_err(|e| GateError(text.into(), e))?;
        let mut p = Parser { tokens, pos: 0 };
        let gate = p.or().map_err(|e| GateError(text.into(), e))?;
        if p.pos != p.tokens.len() {
            return Err(GateError(text.into(), format!("unexpected {:?}", p.tokens[p.pos])));
        }
        Ok(gate)
    }

    pub fn eval(&self, facts: &Facts) -> bool {
        match self {
            Gate::Always => true,
            Gate::Cap(c) => facts.caps.contains(c),
            Gate::Role(r) => match facts.role.as_deref() {
                Some(have) => have == r || (r == "switch" && (have == "access_switch" || have == "l3_switch")),
                None => false,
            },
            Gate::Not(g) => !g.eval(facts),
            Gate::And(a, b) => a.eval(facts) && b.eval(facts),
            Gate::Or(a, b) => a.eval(facts) || b.eval(facts),
        }
    }

    /// Every `cap.` and `role.` name the gate reads, for the plan's "why".
    pub fn names(&self) -> Vec<String> {
        match self {
            Gate::Always => vec![],
            Gate::Cap(c) => vec![format!("cap.{c}")],
            Gate::Role(r) => vec![format!("role.{r}")],
            Gate::Not(g) => g.names(),
            Gate::And(a, b) | Gate::Or(a, b) => {
                let mut v = a.names();
                v.extend(b.names());
                v
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Tok {
    Ident(String),
    Not,
    And,
    Or,
    Open,
    Close,
}

fn tokenize(text: &str) -> Result<Vec<Tok>, String> {
    let mut out = Vec::new();
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            ' ' | '\t' => i += 1,
            '!' => {
                out.push(Tok::Not);
                i += 1;
            }
            '(' => {
                out.push(Tok::Open);
                i += 1;
            }
            ')' => {
                out.push(Tok::Close);
                i += 1;
            }
            '&' if chars.get(i + 1) == Some(&'&') => {
                out.push(Tok::And);
                i += 2;
            }
            '|' if chars.get(i + 1) == Some(&'|') => {
                out.push(Tok::Or);
                i += 2;
            }
            c if c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-' => {
                let start = i;
                while i < chars.len() && (chars[i].is_ascii_alphanumeric() || matches!(chars[i], '_' | '.' | '-')) {
                    i += 1;
                }
                out.push(Tok::Ident(chars[start..i].iter().collect()));
            }
            other => return Err(format!("unexpected character {other:?}")),
        }
    }
    Ok(out)
}

struct Parser {
    tokens: Vec<Tok>,
    pos: usize,
}

impl Parser {
    fn peek(&self) -> Option<&Tok> {
        self.tokens.get(self.pos)
    }
    fn or(&mut self) -> Result<Gate, String> {
        let mut left = self.and()?;
        while self.peek() == Some(&Tok::Or) {
            self.pos += 1;
            let right = self.and()?;
            left = Gate::Or(Box::new(left), Box::new(right));
        }
        Ok(left)
    }
    fn and(&mut self) -> Result<Gate, String> {
        let mut left = self.unary()?;
        while self.peek() == Some(&Tok::And) {
            self.pos += 1;
            let right = self.unary()?;
            left = Gate::And(Box::new(left), Box::new(right));
        }
        Ok(left)
    }
    fn unary(&mut self) -> Result<Gate, String> {
        match self.peek() {
            Some(Tok::Not) => {
                self.pos += 1;
                Ok(Gate::Not(Box::new(self.unary()?)))
            }
            Some(Tok::Open) => {
                self.pos += 1;
                let inner = self.or()?;
                if self.peek() != Some(&Tok::Close) {
                    return Err("missing )".into());
                }
                self.pos += 1;
                Ok(inner)
            }
            Some(Tok::Ident(name)) => {
                let name = name.clone();
                self.pos += 1;
                if name == "always" {
                    Ok(Gate::Always)
                } else if let Some(c) = name.strip_prefix("cap.") {
                    Ok(Gate::Cap(c.to_string()))
                } else if let Some(r) = name.strip_prefix("role.") {
                    Ok(Gate::Role(r.to_string()))
                } else {
                    Err(format!("{name:?} is not always, cap.<flag> or role.<role>"))
                }
            }
            other => Err(format!("expected a term, found {other:?}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn always_is_true_and_an_unknown_flag_is_false() {
        let facts = Facts::default();
        assert!(Gate::parse("always").unwrap().eval(&facts));
        assert!(!Gate::parse("cap.vrf").unwrap().eval(&facts));
        assert!(!Gate::parse("role.firewall").unwrap().eval(&facts));
    }

    #[test]
    fn and_or_not_and_parentheses() {
        let facts = Facts::with_caps(["vrf", "bgp"]).role("router");
        assert!(Gate::parse("cap.vrf && cap.bgp").unwrap().eval(&facts));
        assert!(!Gate::parse("cap.vrf && cap.ospf").unwrap().eval(&facts));
        assert!(Gate::parse("cap.ospf || cap.bgp").unwrap().eval(&facts));
        assert!(Gate::parse("!cap.vdom").unwrap().eval(&facts));
        assert!(Gate::parse("(cap.stack || cap.vpc_mlag_vsx) || role.router").unwrap().eval(&facts));
        assert!(!Gate::parse("!(cap.vrf || cap.bgp)").unwrap().eval(&facts));
        assert!(Gate::parse("cap.routing && !cap.advanced_routing").unwrap().eval(&Facts::with_caps(["routing"])));
    }

    #[test]
    fn a_switch_role_covers_both_switch_roles() {
        assert!(Gate::parse("role.switch").unwrap().eval(&Facts::default().role("access_switch")));
        assert!(Gate::parse("role.switch").unwrap().eval(&Facts::default().role("l3_switch")));
        assert!(!Gate::parse("role.switch").unwrap().eval(&Facts::default().role("router")));
    }

    #[test]
    fn a_bad_gate_says_what_is_wrong() {
        assert!(Gate::parse("cap.vrf &&").unwrap_err().1.contains("expected a term"));
        assert!(Gate::parse("(cap.vrf").unwrap_err().1.contains("missing )"));
        assert!(Gate::parse("vrf").unwrap_err().1.contains("not always"));
        assert!(Gate::parse("cap.vrf cap.bgp").unwrap_err().1.contains("unexpected"));
    }

    #[test]
    fn names_lists_what_the_gate_reads() {
        assert_eq!(Gate::parse("cap.vrf && !cap.vdom || role.wlc").unwrap().names(), vec!["cap.vrf", "cap.vdom", "role.wlc"]);
    }
}
