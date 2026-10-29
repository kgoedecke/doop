//! Serialization of an inline `<svg>` subtree into a standalone SVG document for usvg.
//!
//! usvg sees only the markup it is given, so what the cascade decided has to be written into it:
//! - each element's computed paint (`fill`, `stroke`, their opacities, widths, caps, joins and
//!   dashes), font (`font-family`, `font-size`, `font-weight`, `font-style`, `letter-spacing`)
//!   and `opacity`
//!   become presentation attributes, so author CSS, `var()`, `currentColor` and the page font
//!   reach usvg; the same properties are dropped from `style=""`, which usvg would
//!   otherwise prefer, and so is any declaration usvg cannot read (`var()`);
//! - subtrees with computed `display: none` are left out;
//! - an expanded `<use>` (see `crate::svg_use`) is written as a `<g>` around its clone;
//! - elements referenced by `url(#id)` or `href="#id"` but defined outside the subtree (a
//!   gradient or filter in an icon sprite) are copied into a trailing `<defs>`.

use std::collections::HashSet;

use blitz_traits::node_id::NodeId;
use html_escape::{encode_quoted_attribute_to_string, encode_text_to_string};
use markup5ever::{local_name, ns};
use style::properties::ComputedValues;
use style::values::computed::svg::SVGPaintKind;
use style::values::specified::box_::DisplayOutside;
use style_traits::values::ToCss;

use super::{Node, NodeData};
use crate::svg_use::USE_CLONE_ATTR;

/// SVG paint and font properties carried from the cascade to usvg. Their presentation
/// attributes are mapped to CSS declarations as presentational hints (see `stylo.rs`).
pub(crate) const SVG_PRESENTATION_PROPERTIES: &[&str] = &[
    "fill",
    "fill-opacity",
    "fill-rule",
    "stroke",
    "stroke-width",
    "stroke-linecap",
    "stroke-linejoin",
    "stroke-miterlimit",
    "stroke-opacity",
    "stroke-dasharray",
    "stroke-dashoffset",
    "font-family",
    "font-size",
    "font-weight",
    "font-style",
    "letter-spacing",
];

/// Elements whose computed `display: none` hides them. Paint servers, clip paths, masks,
/// markers, filters and symbols are never rendered directly, so their `display` is ignored.
const RENDERED_ELEMENTS: &[&str] = &[
    "a",
    "circle",
    "ellipse",
    "foreignObject",
    "g",
    "image",
    "line",
    "path",
    "polygon",
    "polyline",
    "rect",
    "svg",
    "switch",
    "text",
    "textPath",
    "tspan",
    "use",
];

const XLINK_NS: &str = "http://www.w3.org/1999/xlink";

impl Node {
    /// Serializes this `<svg>` subtree as a standalone SVG document for usvg, with the computed
    /// paint of every element written as presentation attributes.
    #[cfg(feature = "svg")]
    pub(crate) fn svg_source(&self) -> String {
        let mut output = String::new();
        let mut defined = HashSet::new();
        let mut referenced = Vec::new();
        self.write_svg(&mut output, true, &mut defined, &mut referenced);

        // Copy referenced elements from elsewhere in the document, including what they reference.
        let mut defs = String::new();
        let mut copied = HashSet::new();
        while let Some(id) = referenced.pop() {
            if defined.contains(&id) || !copied.insert(id.clone()) {
                continue;
            }
            if let Some(node) = self.find_element_by_id(&id) {
                node.write_svg(&mut defs, false, &mut defined, &mut referenced);
            }
        }
        if !defs.is_empty() {
            let close = output.rfind("</").unwrap_or(output.len());
            output.insert_str(close, &format!("<defs>{defs}</defs>"));
        }
        output
    }

    fn write_svg(
        &self,
        writer: &mut String,
        is_root: bool,
        defined: &mut HashSet<String>,
        referenced: &mut Vec<String>,
    ) {
        match &self.data {
            NodeData::Text(data) => {
                let in_style = self
                    .parent
                    .and_then(|id| self.tree()[id].data.downcast_element())
                    .is_some_and(|el| el.name.local == local_name!("style"));
                if in_style {
                    writer.push_str(data.content.as_str());
                } else {
                    encode_text_to_string(data.content.as_str(), writer);
                }
            }
            NodeData::Element(data) => {
                let styles = self.primary_styles();
                let style = styles.as_deref();
                let local = &*data.name.local;
                if !is_root
                    && RENDERED_ELEMENTS.contains(&local)
                    && style.is_some_and(|s| s.get_box().display.outside() == DisplayOutside::None)
                {
                    return;
                }
                let is_expanded_use = data.name.ns == ns!(svg)
                    && data.name.local == local_name!("use")
                    && self
                        .children
                        .iter()
                        .any(|&id| is_use_clone(&self.tree()[id]));
                let current_color = style.map(|s| s.clone_color().to_css_string());
                let parent_style = self
                    .parent
                    .filter(|_| !is_root)
                    .and_then(|id| self.tree()[id].primary_styles());
                let paint = style
                    .map(|s| computed_paint(s, parent_style.as_deref().map(|p| &**p)))
                    .unwrap_or_default();

                let mut attrs: Vec<(String, String)> = Vec::new();
                for attr in data.attrs() {
                    let name = qualified_name(attr);
                    let plain = attr.name.ns == ns!();
                    if plain && *attr.name.local == *USE_CLONE_ATTR {
                        continue;
                    }
                    if plain && paint.iter().any(|(property, _)| *property == name) {
                        continue;
                    }
                    if plain && attr.name.local == local_name!("id") {
                        defined.insert(attr.value.clone());
                    }
                    collect_references(&attr.value, referenced);
                    if is_expanded_use
                        && (attr.name.local == local_name!("href")
                            || (plain
                                && matches!(&*attr.name.local, "x" | "y" | "width" | "height")))
                    {
                        continue;
                    }
                    if attr.name.local == local_name!("href") && !is_expanded_use {
                        if let Some(id) = attr.value.strip_prefix('#') {
                            referenced.push(id.to_string());
                        }
                    }
                    let value = if plain && attr.name.local == local_name!("style") {
                        match usvg_inline_style(&attr.value) {
                            Some(value) => value,
                            None => continue,
                        }
                    } else {
                        attr.value.clone()
                    };
                    let value = match &current_color {
                        Some(color) if value.contains("currentColor") => {
                            value.replace("currentColor", color)
                        }
                        _ => value,
                    };
                    attrs.push((name, value));
                }
                if is_expanded_use {
                    let offset = |name| {
                        data.attrs()
                            .iter()
                            .find(|attr| attr.name.ns == ns!() && &*attr.name.local == name)
                            .map_or("0", |attr| attr.value.trim())
                    };
                    let translate = format!("translate({} {})", offset("x"), offset("y"));
                    match attrs.iter_mut().find(|(name, _)| name == "transform") {
                        Some((_, transform)) => *transform = format!("{transform} {translate}"),
                        None => attrs.push(("transform".to_string(), translate)),
                    }
                }
                attrs.extend(
                    paint
                        .into_iter()
                        .filter_map(|(name, value)| Some((name.to_string(), value?))),
                );
                // The root's opacity is the CSS box's, which is painted around the image.
                if !is_root {
                    if let Some(opacity) = style.map(|s| s.get_effects().opacity) {
                        if opacity < 1.0 {
                            attrs.push(("opacity".to_string(), opacity.to_string()));
                        }
                    }
                }

                let tag = if is_expanded_use { "g" } else { local };
                writer.push('<');
                writer.push_str(tag);
                if is_root && !attrs.iter().any(|(name, _)| name == "xmlns:xlink") {
                    writer.push_str(" xmlns:xlink=\"");
                    writer.push_str(XLINK_NS);
                    writer.push('"');
                }
                for (name, value) in &attrs {
                    writer.push(' ');
                    writer.push_str(name);
                    writer.push_str("=\"");
                    encode_quoted_attribute_to_string(value, writer);
                    writer.push('"');
                }
                if self.children.is_empty() {
                    writer.push_str(" />");
                    return;
                }
                writer.push('>');
                for &child_id in &self.children {
                    self.tree()[child_id].write_svg(writer, false, defined, referenced);
                }
                writer.push_str("</");
                writer.push_str(tag);
                writer.push('>');
            }
            _ => {}
        }
    }

    /// The first element in tree order with this `id`.
    fn find_element_by_id(&self, id: &str) -> Option<&Node> {
        let mut root = self;
        while let Some(parent) = root.parent {
            root = &self.tree()[parent];
        }
        let mut stack: Vec<NodeId> = vec![root.id];
        while let Some(node_id) = stack.pop() {
            let node = &self.tree()[node_id];
            if node
                .element_data()
                .is_some_and(|el| el.id.as_deref() == Some(id))
            {
                return Some(node);
            }
            stack.extend(node.children.iter().rev().copied());
        }
        None
    }
}

fn is_use_clone(node: &Node) -> bool {
    node.element_data().is_some_and(|el| {
        el.attrs()
            .iter()
            .any(|attr| *attr.name.local == *USE_CLONE_ATTR)
    })
}

fn qualified_name(attr: &super::Attribute) -> String {
    let prefix = match attr.name.ns {
        ns!(xlink) => "xlink:",
        ns!(xml) => "xml:",
        ns!(xmlns) if &*attr.name.local != "xmlns" => "xmlns:",
        _ => "",
    };
    format!("{prefix}{}", attr.name.local)
}

/// Ids named by `url(#id)` in an attribute value.
fn collect_references(value: &str, referenced: &mut Vec<String>) {
    let mut rest = value;
    while let Some(start) = rest.find("url(") {
        rest = &rest[start + 4..];
        let inner = rest.split(')').next().unwrap_or("");
        let inner = inner.trim().trim_matches(|c| c == '"' || c == '\'');
        if let Some(id) = inner.strip_prefix('#') {
            referenced.push(id.to_string());
        }
    }
}

/// The inline style with the declarations usvg must not see: those the computed attributes
/// already carry, and any that use `var()`. `None` when nothing is left.
fn usvg_inline_style(style: &str) -> Option<String> {
    let kept: Vec<&str> = style
        .split(';')
        .map(str::trim)
        .filter(|declaration| {
            let Some((property, value)) = declaration.split_once(':') else {
                return false;
            };
            let property = property.trim().to_ascii_lowercase();
            !value.contains("var(")
                && property != "opacity"
                && property != "display"
                && !SVG_PRESENTATION_PROPERTIES.contains(&property.as_str())
        })
        .collect();
    (!kept.is_empty()).then(|| kept.join(";"))
}

/// Computed paint and font properties for the presentation attributes that replace the authored ones.
/// The value is `None` where it equals the parent's, since usvg inherits it too (the root
/// writes all of them). A paint usvg cannot be given (a paint server or a context value) is
/// not listed, so the authored attribute stays in place.
fn computed_paint(
    style: &ComputedValues,
    parent: Option<&ComputedValues>,
) -> Vec<(&'static str, Option<String>)> {
    fn values(style: &ComputedValues) -> [Option<String>; 16] {
        let svg = style.get_inherited_svg();
        let font = style.get_font();
        let current_color = style.clone_color();
        let paint = |kind: &SVGPaintKind| match kind {
            SVGPaintKind::None => Some("none".to_string()),
            SVGPaintKind::Color(color) => {
                Some(color.resolve_to_absolute(&current_color).to_css_string())
            }
            _ => None,
        };
        [
            paint(&svg.fill.kind),
            Some(svg.fill_opacity.to_css_string()),
            Some(svg.fill_rule.to_css_string()),
            paint(&svg.stroke.kind),
            Some(svg.stroke_width.to_css_string()),
            Some(svg.stroke_linecap.to_css_string()),
            Some(svg.stroke_linejoin.to_css_string()),
            Some(svg.stroke_miterlimit.to_css_string()),
            Some(svg.stroke_opacity.to_css_string()),
            Some(svg.stroke_dasharray.to_css_string()),
            Some(svg.stroke_dashoffset.to_css_string()),
            Some(font.font_family.to_css_string()),
            Some(font.font_size.computed_size().to_css_string()),
            Some(font.font_weight.to_css_string()),
            // usvg reads the keyword only, not an oblique angle.
            Some(match font.font_style.to_css_string().as_str() {
                "normal" | "italic" => font.font_style.to_css_string(),
                _ => "oblique".to_string(),
            }),
            Some(style.get_inherited_text().letter_spacing.to_css_string()),
        ]
    }
    let own = values(style);
    let inherited = parent.map(values);
    SVG_PRESENTATION_PROPERTIES
        .iter()
        .zip(own)
        .enumerate()
        .filter_map(|(index, (&name, value))| {
            let value = value?;
            let same_as_parent = inherited
                .as_ref()
                .is_some_and(|parent| parent[index].as_deref() == Some(value.as_str()));
            Some((name, (!same_as_parent).then_some(value)))
        })
        .collect()
}
