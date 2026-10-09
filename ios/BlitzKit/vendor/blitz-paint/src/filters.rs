use blitz_dom::util::ToColorColor as _;
use style::color::AbsoluteColor;
pub(crate) use style::computed_values::filter::single_value::T as StyloFilter;

use anyrender::filters::{Filter, FilterEffect};

/// `scale` is the painter's CSS px → device px factor: geometry handed to the
/// painter is already scaled, so filter lengths (blur radii, shadow offsets)
/// must be scaled the same way or they render in device pixels.
pub(crate) fn convert_filters(filters: &[StyloFilter], scale: f64) -> Option<Filter> {
    if filters.is_empty() {
        return None;
    }

    Some(Filter::linear_list(
        filters.iter().filter_map(|f| convert_single_filter(f, scale)),
    ))
}

pub(crate) fn convert_single_filter(filter: &StyloFilter, scale: f64) -> Option<FilterEffect> {
    let px = |v: f32| (v as f64 * scale) as f32;
    Some(match filter {
        StyloFilter::Blur(radius) => FilterEffect::blur(px(radius.px())),
        StyloFilter::Brightness(amount) => FilterEffect::brightness(amount.0),
        StyloFilter::Contrast(amount) => FilterEffect::contrast(amount.0),
        StyloFilter::Grayscale(amount) => FilterEffect::grayscale(amount.0),
        StyloFilter::HueRotate(angle) => FilterEffect::hue_rotate(angle.radians()),
        StyloFilter::Invert(amount) => FilterEffect::invert(amount.0),
        StyloFilter::Opacity(amount) => FilterEffect::opacity(amount.0),
        StyloFilter::Saturate(amount) => FilterEffect::saturate(amount.0),
        StyloFilter::Sepia(amount) => FilterEffect::sepia(amount.0),
        StyloFilter::DropShadow(shadow) => FilterEffect::drop_shadow(
            px(shadow.horizontal.px()),
            px(shadow.vertical.px()),
            px(shadow.blur.px()),
            // TODO: pass in correct currentColor
            shadow
                .color
                .resolve_to_absolute(&AbsoluteColor::BLACK)
                .as_color_color(),
        ),
        StyloFilter::Url(_) => return None,
    })
}
