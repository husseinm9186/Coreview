//! Whatever the file holds, a reader answers or refuses; it never panics
//! (LT-457, the property LT-267 holds every parser to). A drawing somebody
//! exported from a tool this has never seen is the ordinary case, not the
//! edge case.
use proptest::prelude::*;

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    #[test]
    fn a_drawio_reader_never_panics(text in "\\PC{0,600}") {
        let _ = coreview_formats::drawio_import::import_drawio(&text);
    }

    #[test]
    fn a_drawio_reader_survives_xml_shaped_input(inner in "[a-zA-Z0-9 =\"<>/&;#_.-]{0,400}") {
        let text = format!("<mxfile><diagram><mxGraphModel><root>{inner}</root></mxGraphModel></diagram></mxfile>");
        let _ = coreview_formats::drawio_import::import_drawio(&text);
    }

    #[test]
    fn an_nmap_reader_never_panics(text in "\\PC{0,600}") {
        let _ = coreview_formats::nmap_import::read_nmap_xml(&text);
    }

    #[test]
    fn a_vsdx_reader_never_panics(bytes in proptest::collection::vec(any::<u8>(), 0..800)) {
        let _ = coreview_formats::visio_import::import_vsdx(&bytes);
    }
}
