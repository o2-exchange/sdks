/// A non-negative decimal type for prices and quantities.
///
/// Wraps [`rust_decimal::Decimal`] with the invariant that the value is always >= 0.
/// There is no `From<f64>` implementation to prevent accidental precision loss.
/// Serializes as a string in JSON.
use std::fmt;
use std::ops::{Add, Div, Mul};
use std::str::FromStr;

use rust_decimal::Decimal;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::errors::O2Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct UnsignedDecimal(Decimal);

impl UnsignedDecimal {
    /// The one value.
    pub const ONE: Self = Self(Decimal::ONE);

    /// The zero value (constant form).
    pub const ZERO: Self = Self(Decimal::ZERO);

    /// Create a new `UnsignedDecimal`, returning an error if the value is negative.
    pub fn new(value: Decimal) -> Result<Self, O2Error> {
        if value.is_sign_negative() && !value.is_zero() {
            return Err(O2Error::Other(format!(
                "UnsignedDecimal cannot be negative: {value}"
            )));
        }
        Ok(Self(value))
    }

    /// The zero value.
    pub fn zero() -> Self {
        Self(Decimal::ZERO)
    }

    /// Fallible subtraction — returns an error if the result would be negative.
    pub fn try_sub(&self, other: Self) -> Result<Self, O2Error> {
        Self::new(self.0 - other.0)
    }

    /// Access the inner `Decimal`.
    pub fn inner(&self) -> &Decimal {
        &self.0
    }

    /// Consume and return the inner `Decimal`.
    pub fn into_inner(self) -> Decimal {
        self.0
    }
}

impl fmt::Display for UnsignedDecimal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl FromStr for UnsignedDecimal {
    type Err = O2Error;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let d = Decimal::from_str(s)
            .map_err(|e| O2Error::Other(format!("Invalid decimal '{s}': {e}")))?;
        Self::new(d)
    }
}

impl Serialize for UnsignedDecimal {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0.to_string())
    }
}

impl<'de> Deserialize<'de> for UnsignedDecimal {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let s = String::deserialize(deserializer)?;
        let d = Decimal::from_str(&s).map_err(serde::de::Error::custom)?;
        Self::new(d).map_err(serde::de::Error::custom)
    }
}

impl From<u64> for UnsignedDecimal {
    fn from(v: u64) -> Self {
        Self(Decimal::from(v))
    }
}

impl From<u32> for UnsignedDecimal {
    fn from(v: u32) -> Self {
        Self(Decimal::from(v))
    }
}

impl Add for UnsignedDecimal {
    type Output = Self;
    fn add(self, rhs: Self) -> Self::Output {
        Self(self.0 + rhs.0)
    }
}

impl Mul for UnsignedDecimal {
    type Output = Self;
    fn mul(self, rhs: Self) -> Self::Output {
        Self(self.0 * rhs.0)
    }
}

impl Div for UnsignedDecimal {
    type Output = Self;
    fn div(self, rhs: Self) -> Self::Output {
        Self(self.0 / rhs.0)
    }
}
