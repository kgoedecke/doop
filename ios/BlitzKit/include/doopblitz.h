// C ABI of the doopblitz Rust static library (ios/BlitzKit/rust).
// One DoopBlitzDoc per frame. Drive every call for a document from one serial
// queue. Coordinates are CSS pixels in the frame's own space.
#ifndef DOOPBLITZ_H
#define DOOPBLITZ_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct DoopBlitzDoc DoopBlitzDoc;
typedef void (*DoopBlitzWakeCallback)(size_t doc_id);

/// Called from a network thread when a pending font or image for `doc_id` arrives.
void doopblitz_set_wake_callback(DoopBlitzWakeCallback callback);

DoopBlitzDoc *doopblitz_doc_new(const char *html, const char *base_url, uint32_t width, uint32_t height, float scale);
void doopblitz_doc_free(DoopBlitzDoc *doc);
size_t doopblitz_doc_id(const DoopBlitzDoc *doc);
void doopblitz_doc_set_html(DoopBlitzDoc *doc, const char *html);
void doopblitz_doc_set_viewport(DoopBlitzDoc *doc, uint32_t width, uint32_t height, float scale);
bool doopblitz_doc_loading(const DoopBlitzDoc *doc);

/// RGBA8, premultiplied alpha over white. Free with doopblitz_buffer_free.
uint8_t *doopblitz_doc_render(DoopBlitzDoc *doc, uint32_t *out_width, uint32_t *out_height, size_t *out_len);
/// Same, with CSS animations advanced to `time` seconds.
uint8_t *doopblitz_doc_render_at(DoopBlitzDoc *doc, double time, uint32_t *out_width, uint32_t *out_height, size_t *out_len);
/// True when the document has running CSS animations or transitions.
bool doopblitz_doc_is_animating(const DoopBlitzDoc *doc);
/// Paint only the frame region (x, y, width, height in CSS px) at `scale` bitmap px per CSS px.
uint8_t *doopblitz_doc_render_region(DoopBlitzDoc *doc, float scale, float x, float y, float width, float height,
                                     uint32_t *out_width, uint32_t *out_height, size_t *out_len);
/// Same, with CSS animations advanced to `time` seconds.
uint8_t *doopblitz_doc_render_region_at(DoopBlitzDoc *doc, double time, float scale, float x, float y, float width,
                                        float height, uint32_t *out_width, uint32_t *out_height, size_t *out_len);
void doopblitz_buffer_free(uint8_t *ptr, size_t len);

/// Node ids are opaque non-zero values; 0 means none.
uint64_t doopblitz_doc_element_from_point(DoopBlitzDoc *doc, float x, float y);
uint64_t doopblitz_doc_query_selector(const DoopBlitzDoc *doc, const char *selector);
uint64_t doopblitz_node_parent(const DoopBlitzDoc *doc, uint64_t node);
/// out receives x, y, width, height in CSS pixels.
bool doopblitz_node_rect(const DoopBlitzDoc *doc, uint64_t node, float *out);
/// JSON: {id, tag, idAttr, classes, selector, text, parent, rect}. Free with doopblitz_string_free.
char *doopblitz_node_info(const DoopBlitzDoc *doc, uint64_t node);
void doopblitz_string_free(char *ptr);

#ifdef __cplusplus
}
#endif
#endif
