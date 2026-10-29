use std::ops::Deref;
use std::str::FromStr;

use style::servo_arc::Arc as ServoArc;
use style::stylesheets::UrlExtraData;
use url::{Position, Url};

#[derive(Clone)]
pub(crate) struct DocumentUrl {
    base_url: ServoArc<Url>,
}

impl DocumentUrl {
    /// Create a stylo `UrlExtraData` from the URL
    pub(crate) fn url_extra_data(&self) -> UrlExtraData {
        UrlExtraData(ServoArc::clone(&self.base_url))
    }

    pub(crate) fn resolve_relative(&self, raw: &str) -> Option<url::Url> {
        self.base_url.join(raw).ok()
    }

    /// Returns `true` if `other` refers to the same document as this URL, i.e. it is
    /// identical to this URL except (possibly) for the fragment (`#...`) component.
    ///
    /// This is used to decide whether following a link should perform in-page fragment
    /// navigation (scrolling) rather than a full navigation.
    pub(crate) fn is_same_document(&self, other: &Url) -> bool {
        let this: &Url = &self.base_url;
        this[..Position::AfterQuery] == other[..Position::AfterQuery]
    }
}

impl Default for DocumentUrl {
    fn default() -> Self {
        Self::from_str("data:text/css;charset=utf-8;base64,").unwrap()
    }
}
impl FromStr for DocumentUrl {
    type Err = <Url as FromStr>::Err;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let base_url = ServoArc::new(Url::parse(s)?);
        Ok(Self { base_url })
    }
}
impl From<Url> for DocumentUrl {
    fn from(base_url: Url) -> Self {
        Self {
            base_url: ServoArc::new(base_url),
        }
    }
}
impl From<ServoArc<Url>> for DocumentUrl {
    fn from(base_url: ServoArc<Url>) -> Self {
        Self { base_url }
    }
}
impl Deref for DocumentUrl {
    type Target = Url;
    fn deref(&self) -> &Self::Target {
        &self.base_url
    }
}
