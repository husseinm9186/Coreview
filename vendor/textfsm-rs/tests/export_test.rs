use textfsm_rs::{OutputFormat, TextFSM, TextFsmExport};

fn get_results() -> Vec<textfsm_rs::DataRecord> {
    let template = r###"Value Name (\S+)
Value Age (\d+)

Start
  ^Name: ${Name}
  ^Age: ${Age} -> Record
"###;

    let data = "Name: Alice\nAge: 30\nName: Bob\nAge: 25\n";

    let mut fsm = TextFSM::from_string(template).unwrap();
    fsm.parse_string(data, None).unwrap()
}

#[test]
#[cfg(feature = "json")]
fn test_export_json() {
    let results = get_results();
    let json = results.export(OutputFormat::Json).unwrap();
    assert!(json.contains("\"Name\": \"Alice\""));
    assert!(json.contains("\"Age\": \"30\""));
}

#[test]
#[cfg(feature = "yaml")]
fn test_export_yaml() {
    let results = get_results();
    let yaml = results.export(OutputFormat::Yaml).unwrap();
    assert!(yaml.contains("Name: Alice"));
    assert!(yaml.contains("Age: '30'"));
}

#[test]
#[cfg(feature = "csv_export")]
fn test_export_csv() {
    let results = get_results();
    let csv = results.export(OutputFormat::Csv).unwrap();
    // Headers are sorted alphabetically: Age,Name
    assert!(csv.contains("Age,Name"));
    assert!(csv.contains("30,Alice"));
    assert!(csv.contains("25,Bob"));
}

#[test]
fn test_export_html() {
    let results = get_results();
    let html = results.export(OutputFormat::Html).unwrap();
    assert!(html.contains("<table>"));
    assert!(html.contains("<th>Age</th>"));
    assert!(html.contains("<th>Name</th>"));
    assert!(html.contains("<td>Alice</td>"));
}

#[test]
fn test_export_text() {
    let results = get_results();
    let text = results.export(OutputFormat::Text).unwrap();
    println!("TEXT:\n{:?}", text);
    // Age width: 3 ("Age"), Name width: 5 ("Alice")
    assert!(text.contains("Age  Name"));
    assert!(text.contains("---  -----"));
    assert!(text.contains("30   Alice"));
}

#[test]
fn test_export_xml() {
    let results = get_results();
    let xml = results.export(OutputFormat::Xml).unwrap();
    assert!(xml.contains("<results>"));
    assert!(xml.contains("<record>"));
    assert!(xml.contains("<Name>Alice</Name>"));
    assert!(xml.contains("<Age>30</Age>"));
    assert!(xml.contains("</record>"));
    assert!(xml.contains("</results>"));
}

#[test]
fn test_export_escaping() {
    let template = r###"Value MSG (.+)

Start
  ^Message: ${MSG} -> Record
"###;
    let data = "Message: <Hello> & \"World\"\n";

    let mut fsm = TextFSM::from_string(template).unwrap();
    let results = fsm.parse_string(data, None).unwrap();

    // XML
    let xml = results.export(OutputFormat::Xml).unwrap();
    assert!(xml.contains("&lt;Hello&gt; &amp; &quot;World&quot;"));

    // HTML
    let html = results.export(OutputFormat::Html).unwrap();
    assert!(html.contains("&lt;Hello&gt; &amp; &quot;World&quot;"));
}
