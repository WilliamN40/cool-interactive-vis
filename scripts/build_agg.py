import json
import math
import os
import re
from collections import Counter, defaultdict

import pandas as pd


INPUT_DIR_DEFAULT = "parking-tickets-2024"
OUTPUT_FILE_DEFAULT = os.path.join("data", "agg_parking_v1.json")


def parse_hour(time_of_infraction: pd.Series) -> pd.Series:
    """
    time_of_infraction is stored as a string like '0001', '1345', etc.
    We extract the hour as the first two digits after zero-padding to 4 chars.
    """
    s = time_of_infraction.fillna("").astype(str).str.strip().str.zfill(4)
    hour = pd.to_numeric(s.str.slice(0, 2), errors="coerce")
    return hour


def province_group(province: pd.Series) -> pd.Series:
    # Only keep coarse groups to keep the interactive dataset small.
    prov = province.fillna("").astype(str)
    return pd.Series(
        pd.Categorical(
            [
                "ON" if p == "ON" else ("QC" if p == "QC" else "Other")
                for p in prov.tolist()
            ],
            categories=["ON", "QC", "Other"],
        )
    )


def main(
    input_dir: str = INPUT_DIR_DEFAULT,
    output_file: str = OUTPUT_FILE_DEFAULT,
    top_streets: int = 220,
    top_violations: int = 8,
    year: int = 2024,
):
    input_dir = os.path.abspath(input_dir)
    output_file = os.path.abspath(output_file)
    os.makedirs(os.path.dirname(output_file), exist_ok=True)

    csv_paths = sorted(
        [
            os.path.join(input_dir, p)
            for p in os.listdir(input_dir)
            if p.lower().endswith(".csv")
        ]
    )
    if not csv_paths:
        raise FileNotFoundError(f"No CSV files found in: {input_dir}")

    usecols = [
        "date_of_infraction",
        "infraction_description",
        "set_fine_amount",
        "time_of_infraction",
        "location2",
        "province",
        "tag_number_masked",
    ]

    # Pass 1: find top streets + top violations by ticket count.
    street_counts: Counter[str] = Counter()
    violation_counts: Counter[str] = Counter()

    print("Pass 1: counting top streets/violations...")
    chunksize = 200_000
    for path in csv_paths:
        for chunk in pd.read_csv(path, usecols=usecols, dtype=str, chunksize=chunksize, low_memory=False):
            year_str = chunk["date_of_infraction"].fillna("").astype(str).str.slice(0, 4)
            chunk = chunk[year_str == str(year)]
            if len(chunk) == 0:
                continue

            street = chunk["location2"].fillna("").astype(str).str.strip()
            violation = chunk["infraction_description"].fillna("").astype(str).str.strip()
            hour = parse_hour(chunk["time_of_infraction"])
            valid = street.ne("") & violation.ne("") & hour.notna() & hour.between(0, 23)
            chunk = chunk[valid]
            if len(chunk) == 0:
                continue

            street_counts.update(street[valid].value_counts(dropna=False).to_dict())
            violation_counts.update(violation[valid].value_counts(dropna=False).to_dict())

    top_streets_list = [s for s, _ in street_counts.most_common(top_streets)]
    top_violations_list = [v for v, _ in violation_counts.most_common(top_violations)]
    top_viol_set = set(top_violations_list)
    top_street_set = set(top_streets_list)

    print(f"Top streets: {len(top_streets_list)}")
    print(f"Top violations: {len(top_violations_list)}")

    # Coarse time-of-day buckets (used by the UI dropdown).
    # Store explicit hour lists so "Night" can wrap around midnight.
    time_buckets = [
        {"name": "All", "hours": list(range(0, 24))},
        {"name": "Morning", "hours": list(range(6, 12))},  # 6-11
        {"name": "Afternoon", "hours": list(range(12, 17))},  # 12-16
        {"name": "Evening", "hours": list(range(17, 22))},  # 17-21
        {"name": "Night", "hours": list(range(22, 24)) + list(range(0, 6))},  # 22-23 + 0-5
    ]

    # Pass 2: aggregate by (provinceGroup, street, hour, violationBucket).
    street_hour_violation = defaultdict(lambda: [0, 0.0])  # key -> [count, fineSum]
    global_hour_violation = defaultdict(lambda: [0, 0.0])
    street_totals = defaultdict(lambda: [0, 0.0])  # key -> [count, fineSum]
    global_hour_total = defaultdict(lambda: 0)  # key -> count

    print("Pass 2: aggregating...")
    for path in csv_paths:
        for chunk in pd.read_csv(path, usecols=usecols, dtype=str, chunksize=chunksize, low_memory=False):
            year_str = chunk["date_of_infraction"].fillna("").astype(str).str.slice(0, 4)
            chunk = chunk[year_str == str(year)]
            if len(chunk) == 0:
                continue

            street = chunk["location2"].fillna("").astype(str).str.strip()
            violation = chunk["infraction_description"].fillna("").astype(str).str.strip()
            hour = parse_hour(chunk["time_of_infraction"])
            fine = pd.to_numeric(chunk["set_fine_amount"], errors="coerce").fillna(0.0)

            valid = street.ne("") & violation.ne("") & hour.notna() & hour.between(0, 23)
            chunk = chunk[valid].copy()
            if len(chunk) == 0:
                continue

            # Province -> coarse group to keep dataset small.
            prov_group = province_group(chunk["province"]).astype(str)

            hour_int = parse_hour(chunk["time_of_infraction"]).astype(int)
            street_clean = chunk["location2"].fillna("").astype(str).str.strip()
            violation_clean = chunk["infraction_description"].fillna("").astype(str).str.strip()
            fine_clean = pd.to_numeric(chunk["set_fine_amount"], errors="coerce").fillna(0.0).astype(float)

            violation_bucket = violation_clean.where(violation_clean.isin(top_viol_set), other="Other")

            # Global aggregation uses all streets (but bucketed violations only).
            g = pd.DataFrame({"provinceGroup": prov_group.values, "hour": hour_int.values, "violation": violation_bucket.values, "fine": fine_clean.values})
            global_grouped = (
                g.groupby(["provinceGroup", "hour", "violation"], sort=False)
                .agg(count=("fine", "size"), fineSum=("fine", "sum"))
                .reset_index()
            )
            for row in global_grouped.itertuples(index=False):
                key = (row.provinceGroup, int(row.hour), str(row.violation))
                rec = global_hour_violation[key]
                rec[0] += int(row.count)
                rec[1] += float(row.fineSum)
                global_hour_total[(row.provinceGroup, int(row.hour))] += int(row.count)

            # Street-restricted aggregation (only top streets for the map + linked selection).
            mask_top_street = street_clean.isin(top_street_set)
            if not mask_top_street.any():
                continue

            s = pd.DataFrame(
                {
                    "provinceGroup": prov_group.values[mask_top_street.values],
                    "street": street_clean.values[mask_top_street.values],
                    "hour": hour_int.values[mask_top_street.values],
                    "violation": violation_bucket.values[mask_top_street.values],
                    "fine": fine_clean.values[mask_top_street.values],
                }
            )
            street_grouped = (
                s.groupby(["provinceGroup", "street", "hour", "violation"], sort=False)
                .agg(count=("fine", "size"), fineSum=("fine", "sum"))
                .reset_index()
            )
            for row in street_grouped.itertuples(index=False):
                key_sv = (row.provinceGroup, str(row.street), int(row.hour), str(row.violation))
                rec_sv = street_hour_violation[key_sv]
                rec_sv[0] += int(row.count)
                rec_sv[1] += float(row.fineSum)

                key_tot = (row.provinceGroup, str(row.street))
                rec_tot = street_totals[key_tot]
                rec_tot[0] += int(row.count)
                rec_tot[1] += float(row.fineSum)

    # Convert to compact JSON-friendly arrays.
    aggStreetHourViolation = []
    for (prov, street, hour, viol), (count, fine_sum) in street_hour_violation.items():
        aggStreetHourViolation.append(
            {
                "provinceGroup": prov,
                "street": street,
                "hour": hour,
                "violation": viol,
                "count": int(count),
                "fineSum": float(fine_sum),
            }
        )

    aggGlobalHourViolation = []
    for (prov, hour, viol), (count, fine_sum) in global_hour_violation.items():
        aggGlobalHourViolation.append(
            {
                "provinceGroup": prov,
                "hour": hour,
                "violation": viol,
                "count": int(count),
                "fineSum": float(fine_sum),
            }
        )

    streetTotals = []
    for (prov, street), (count, fine_sum) in street_totals.items():
        streetTotals.append(
            {"provinceGroup": prov, "street": street, "count": int(count), "fineSum": float(fine_sum)}
        )

    globalHourTotal = []
    for (prov, hour), count in global_hour_total.items():
        globalHourTotal.append({"provinceGroup": prov, "hour": hour, "count": int(count)})

    out = {
        "meta": {
            "generatedAt": pd.Timestamp.now().isoformat(),
            "year": year,
            "topStreets": top_streets,
            "topViolations": top_violations,
            "inputDir": os.path.basename(input_dir),
            "note": "Aggregated for fast D3 interaction. Street map shows only top streets; global charts are based on all streets but bucketed to top violations+Other.",
        },
        "provinceGroups": ["ON", "QC", "Other"],
        "topStreets": top_streets_list,
        "topViolations": top_violations_list,
        "timeBuckets": time_buckets,
        "aggGlobalHourTotal": globalHourTotal,
        "aggGlobalHourViolation": aggGlobalHourViolation,
        "aggStreetHourViolation": aggStreetHourViolation,
        "streetTotals": streetTotals,
    }

    with open(output_file, "w", encoding="utf-8") as f:
        json.dump(out, f)

    print(f"Wrote: {output_file}")
    print(f"aggStreetHourViolation records: {len(aggStreetHourViolation)}")
    print(f"aggGlobalHourViolation records: {len(aggGlobalHourViolation)}")


if __name__ == "__main__":
    main()

