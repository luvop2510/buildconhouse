"""Reference display and floor-scoped acquisition enrichment without data writes."""
from services.analytics.filters import AnalyticsFilter
from services.analytics.lead_referrals import acquisition_pipeline


def referrer_code(referrer_id, kind=None, name=None):
    first_name = f"-{str(name).split()[0][:12].upper()}" if name and str(name).strip() else ""
    return f"{'ARC' if kind == 'architect' else 'INT'}{first_name}-{str(referrer_id)[:8].upper()}" if referrer_id else ""


def referrer_label(document):
    name = document.get('referrer_name') or legacy_referrer_name(document)
    return ' · '.join(filter(None, [name, referrer_code(document.get('referrer_id'), document.get('referrer_type'), name)]))


def legacy_referrer_name(document):
    # These are names, not acquisition channels such as Walk-in or Instagram.
    return next((document.get(key) for key in ('architect_name', 'interior_designer_name', 'architect_interior_designer', 'architect') if document.get(key)), None)


async def acquired_counts(database, referrer_ids, floors):
    ids = list(dict.fromkeys(value for value in referrer_ids if value))
    if not ids:
        return {}
    collection, pipeline = acquisition_pipeline(AnalyticsFilter(status='any'), floors, (None, None))
    pipeline[0]['$match']['referrer_id'] = {'$in': ids}
    for stage in pipeline:
        if '$unionWith' in stage:
            stage['$unionWith']['pipeline'][0]['$match']['referrer_id'] = {'$in': ids}
    # This is an identity lookup, not the dashboard's top-100 leaderboard.
    pipeline = [stage for stage in pipeline if '$limit' not in stage]
    rows = await database[collection].aggregate(pipeline).to_list(len(ids))
    return {row['id']: int(row.get('customers_acquired') or 0) for row in rows}


def referrer_query(scope, base=None):
    """Shared contacts cross floors; associated customers and sales never do."""
    scope = dict(scope)
    floor = scope.pop('floor_id', None)
    if floor is None:
        return {**scope, **(base or {})}
    # A caller without any floor access cannot read the shared directory.
    shared = [] if isinstance(floor, dict) and floor.get('$in') == [] else [{'shared_across_floors': True}]
    return {**scope, **(base or {}), '$or': [{'floor_id': floor}, *shared]}


async def resolve_referrer(database, referrer_id, user):
    from auth import accessible_floor_ids
    from fastapi import HTTPException
    referrer = await database.referrers.find_one({'id': referrer_id}, {'_id': 0})
    allowed = accessible_floor_ids(user)
    if not referrer or not referrer.get('floor_id') or (allowed is not None and (
        not allowed or (referrer['floor_id'] not in allowed and not referrer.get('shared_across_floors'))
    )):
        raise HTTPException(status_code=404, detail='Referrer not found')
    return referrer
