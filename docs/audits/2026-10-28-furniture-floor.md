# Furniture Floor follow-ups, payments and read latency

Furniture follow-ups use the compact catalog-floor controls and display a floor worker rather than an owner creator as salesperson. Legacy order attribution remains stored for filtering and history. Furniture payment reads, history, exports and fully paid orders are restricted to the selected Furniture floor; late responses from another floor cannot replace its view.

## Performance evidence

The RNB quotation editor no longer waits for the optional referrer acquisition count. In a controlled ten-run test with a 10 ms simulated document lookup and 100 ms simulated acquisition lookup, median time to the initial document was 112.1 ms before and 11.0 ms after. This is a synthetic isolation test, not a live latency measurement. The optional count still loads separately and cannot overwrite a different or newer document.

For Furniture sales reports, the query skips the catalog line aggregation and the unrelated Kitchen union. Floor access validation and reporting calculations remain in place. Local Mongo integration and unit tests verify results; production response-time improvement has not been measured. Measure the same Furniture report and quotation journeys before and after release on representative data and network conditions before claiming a field improvement.
