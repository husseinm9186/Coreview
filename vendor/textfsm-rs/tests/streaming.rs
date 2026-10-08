use std::io::Cursor;
use textfsm_rs::TextFSM;

#[test]
fn test_parse_reader_streaming() {
    let template = r###"Value Name (\S+)
Value Age (\d+)

Start
  ^Name: ${Name}
  ^Age: ${Age} -> Record
"###;

    let data = "Name: Alice\nAge: 30\nName: Bob\nAge: 25\nName: Charlie\nAge: 40\n";

    let fsm = TextFSM::from_string(template).unwrap();

    let reader = Cursor::new(data);
    let mut iter = fsm.parse_reader(reader);

    let rec1 = iter
        .next()
        .expect("Should have record 1")
        .expect("Should be Ok");
    assert_eq!(rec1.fields.get("Name").unwrap().to_string(), "Alice");
    assert_eq!(rec1.fields.get("Age").unwrap().to_string(), "30");

    let rec2 = iter
        .next()
        .expect("Should have record 2")
        .expect("Should be Ok");
    assert_eq!(rec2.fields.get("Name").unwrap().to_string(), "Bob");
    assert_eq!(rec2.fields.get("Age").unwrap().to_string(), "25");

    let rec3 = iter
        .next()
        .expect("Should have record 3")
        .expect("Should be Ok");
    assert_eq!(rec3.fields.get("Name").unwrap().to_string(), "Charlie");
    assert_eq!(rec3.fields.get("Age").unwrap().to_string(), "40");

    assert!(iter.next().is_none());
}

#[test]
fn test_parse_reader_eof_record() {
    let template = r###"Value Name (\S+)

Start
  ^Name: ${Name}
"###;
    // No explicit 'Record' action, so it should record on EOF if Name is set (and not empty)

    let data = "Name: Dave";

    let fsm = TextFSM::from_string(template).unwrap();
    let reader = Cursor::new(data);
    let mut iter = fsm.parse_reader(reader);

    let rec1 = iter
        .next()
        .expect("Should have record")
        .expect("Should be Ok");
    assert_eq!(rec1.fields.get("Name").unwrap().to_string(), "Dave");

    assert!(iter.next().is_none());
}
