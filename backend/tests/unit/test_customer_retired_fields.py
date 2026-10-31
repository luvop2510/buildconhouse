from models import CustomerPublic, CustomerCreate, CustomerUpdatePayload

def test_retired_customer_fields_are_not_published_or_written():
    fields=dict(company='Company',alternate_phone='123',city='City',state='State',pincode='123456',gstin='GST')
    for model in (CustomerCreate(name='Person',**fields),CustomerPublic(name='Person',floor_id='ground-floor',**fields),CustomerUpdatePayload(**fields)):
        assert not (fields.keys() & model.model_dump().keys())
    assert fields['company']=='Company'
